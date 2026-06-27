export enum PacketPriority {
  CRITICAL = 0,
  STANDARD = 1,
  METRIC = 2, // Historical tracing metrics
}

export interface IngestionPacket {
  priority: PacketPriority;
  data: any;
  timestamp: number;
}

export interface BackpressureMetrics {
  queueLength: number;
  maxCapacity: number;
  saturation: number;
  droppedPackets: number;
  slowedDownIngestions: number;
  averageProcessingTime: number;
}

export interface BackpressureConfig {
  maxCapacity: number;
  dropThreshold: number; // 0-1, percentage of capacity to start dropping
  slowDownThreshold: number; // 0-1, percentage of capacity to start slowing down
  slowDownDelay: number; // milliseconds to delay when slowing down
  enableMetrics: boolean;
}

/**
 * Async bounded queue with backpressure support.
 * Similar to Python's asyncio.Queue but with backpressure rules.
 */
export class AsyncBoundedQueue<T> {
  private queue: T[] = [];
  private waitingConsumers: Array<(value: T) => void> = [];
  private waitingProducers: Array<(value: boolean) => void> = [];
  private closed: boolean = false;

  constructor(private readonly maxSize: number) { }

  /**
   * Add an item to the queue. If queue is full, wait until space is available.
   */
  async put(item: T): Promise<void> {
    if (this.closed) {
      throw new Error("Queue is closed");
    }

    if (this.queue.length < this.maxSize) {
      this.queue.push(item);
      this.notifyConsumer();
      return;
    }

    // Queue is full, wait for space
    return new Promise((resolve) => {
      this.waitingProducers.push(() => {
        this.queue.push(item);
        this.notifyConsumer();
        resolve();
      });
    });
  }

  /**
   * Add an item to the queue without blocking. Returns false if queue is full.
   */
  tryPut(item: T): boolean {
    if (this.closed || this.queue.length >= this.maxSize) {
      return false;
    }
    this.queue.push(item);
    this.notifyConsumer();
    return true;
  }

  /**
   * Remove and return an item from the queue. If queue is empty, wait until item is available.
   */
  async get(): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    if (this.closed) {
      throw new Error("Queue is closed and empty");
    }

    // Queue is empty, wait for item
    return new Promise((resolve) => {
      this.waitingConsumers.push(resolve);
    });
  }

  /**
   * Remove and return an item from the queue without blocking. Returns undefined if empty.
   */
  tryGet(): T | undefined {
    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.notifyProducer();
      return item;
    }
    return undefined;
  }

  /**
   * Return current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /**
   * Close the queue, preventing further puts
   */
  close(): void {
    this.closed = true;
    // Notify all waiting consumers
    while (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift()!;
      consumer(undefined as any); // Will throw "Queue is closed and empty"
    }
    // Notify all waiting producers
    while (this.waitingProducers.length > 0) {
      const producer = this.waitingProducers.shift()!;
      producer(false);
    }
  }

  private notifyConsumer(): void {
    if (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift()!;
      consumer(this.queue.shift()!);
      this.notifyProducer();
    }
  }

  private notifyProducer(): void {
    if (this.waitingProducers.length > 0 && this.queue.length < this.maxSize) {
      const producer = this.waitingProducers.shift()!;
      producer(true);
    }
  }
}

export class BackpressureManager {
  private queue: AsyncBoundedQueue<IngestionPacket>;
  private config: BackpressureConfig;
  private metrics: BackpressureMetrics;
  private processingTimes: number[] = [];
  private readonly MAX_PROCESSING_TIME_SAMPLES = 100;

  constructor(config?: Partial<BackpressureConfig>) {
    this.config = {
      maxCapacity: 1000,
      dropThreshold: 0.9,
      slowDownThreshold: 0.7,
      slowDownDelay: 100,
      enableMetrics: true,
      ...config,
    };

    this.queue = new AsyncBoundedQueue<IngestionPacket>(
      this.config.maxCapacity,
    );
    this.metrics = {
      queueLength: 0,
      maxCapacity: this.config.maxCapacity,
      saturation: 0,
      droppedPackets: 0,
      slowedDownIngestions: 0,
      averageProcessingTime: 0,
    };
  }

  /**
   * Adds a packet to the ingestion stream with backpressure logic.
   * Returns true if enqueued, false if dropped due to backpressure.
   */
  async enqueue(packet: IngestionPacket): Promise<boolean> {
    const saturation = this.queue.size() / this.config.maxCapacity;
    this.updateMetrics();

    // Apply backpressure rules
    if (saturation >= this.config.slowDownThreshold) {
      // Slow down ingestion by adding delay
      await this.applySlowDown(saturation);
    }

    if (saturation >= this.config.dropThreshold) {
      // Drop-tail strategy: Reject non-essential metrics when saturated
      if (packet.priority === PacketPriority.METRIC) {
        console.warn(
          `[Backpressure] Saturation at ${Math.round(saturation * 100)}%. Dropping metric packet.`,
        );
        this.metrics.droppedPackets++;
        return false;
      }
    }

    // Try to enqueue without blocking first
    // Fast path
    if (this.queue.tryPut(packet)) {
      return true;
    }

    // Drop metric packets when heavily saturated
    if (
      saturation >= this.config.dropThreshold &&
      packet.priority === PacketPriority.METRIC
    ) {
      console.warn(
        `[Backpressure] Saturation at ${Math.round(
          saturation * 100,
        )}%. Dropping metric packet.`,
      );

      this.metrics.droppedPackets++;
      return false;
    }

    // Queue is at capacity.
    // Apply hard backpressure by blocking producers until space is available.
    try {
      await this.queue.put(packet);

      console.debug(
        `[Backpressure] Queue full. Producer blocked until capacity became available.`,
      );

      return true;
    } catch (error) {
      console.error(
        "[Backpressure] Failed to enqueue packet:",
        error,
      );

      this.metrics.droppedPackets++;
      return false;
    }
  }

  /**
   * Removes a packet from the queue for processing.
   */
  async dequeue(): Promise<IngestionPacket | undefined> {
    const startTime = Date.now();

    try {
      const packet = await this.queue.get();
      const processingTime = Date.now() - startTime;
      this.recordProcessingTime(processingTime);
      this.updateMetrics();
      return packet;
    } catch (error) {
      // Queue is closed or empty
      return undefined;
    }
  }

  /**
   * Try to dequeue without blocking.
   */
  tryDequeue(): IngestionPacket | undefined {
    const startTime = Date.now();
    const packet = this.queue.tryGet();

    if (packet) {
      const processingTime = Date.now() - startTime;
      this.recordProcessingTime(processingTime);
      this.updateMetrics();
    }

    return packet;
  }

  /**
   * Apply slow down delay based on saturation level.
   */
  private async applySlowDown(saturation: number): Promise<void> {
    const delayMultiplier =
      (saturation - this.config.slowDownThreshold) /
      (1 - this.config.slowDownThreshold);
    const delay = this.config.slowDownDelay * delayMultiplier;

    if (delay > 0) {
      this.metrics.slowedDownIngestions++;
      console.debug(
        `[Backpressure] Slowing down ingestion by ${Math.round(delay)}ms (saturation: ${Math.round(saturation * 100)}%)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Record processing time for metrics.
   */
  private recordProcessingTime(time: number): void {
    this.processingTimes.push(time);
    if (this.processingTimes.length > this.MAX_PROCESSING_TIME_SAMPLES) {
      this.processingTimes.shift();
    }

    if (this.processingTimes.length > 0) {
      const sum = this.processingTimes.reduce((a, b) => a + b, 0);
      this.metrics.averageProcessingTime = sum / this.processingTimes.length;
    }
  }

  /**
   * Update metrics based on current state.
   */
  private updateMetrics(): void {
    this.metrics.queueLength = this.queue.size();
    this.metrics.saturation =
      this.metrics.queueLength / this.config.maxCapacity;
  }

  /**
   * Get current backpressure metrics.
   */
  getMetrics(): BackpressureMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Get current queue length.
   */
  getQueueLength(): number {
    return this.queue.size();
  }

  /**
   * Get queue capacity.
   */
  getMaxCapacity(): number {
    return this.config.maxCapacity;
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.metrics = {
      queueLength: this.queue.size(),
      maxCapacity: this.config.maxCapacity,
      saturation: this.queue.size() / this.config.maxCapacity,
      droppedPackets: 0,
      slowedDownIngestions: 0,
      averageProcessingTime: 0,
    };
    this.processingTimes = [];
  }

  /**
   * Close the queue and cleanup.
   */
  shutdown(): void {
    this.queue.close();
    console.info("[Backpressure] Queue closed and shutdown complete");
  }
}
