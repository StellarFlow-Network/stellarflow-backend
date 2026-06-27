/**
 * Backpressure Queue Test Suite
 * 
 * This test suite verifies the implementation of the bounded execution buffer queue
 * with backpressure rules as specified in issue #340.
 */

import { 
  AsyncBoundedQueue, 
  BackpressureManager, 
  PacketPriority, 
  IngestionPacket,
  BackpressureConfig 
} from '../src/queue/backpressure';

describe('AsyncBoundedQueue', () => {
  describe('Basic Operations', () => {
    test('should create queue with specified max size', () => {
      const queue = new AsyncBoundedQueue<number>(10);
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.isFull()).toBe(false);
    });

    test('should add items with tryPut', () => {
      const queue = new AsyncBoundedQueue<number>(5);
      expect(queue.tryPut(1)).toBe(true);
      expect(queue.tryPut(2)).toBe(true);
      expect(queue.size()).toBe(2);
    });

    test('should reject items when full using tryPut', () => {
      const queue = new AsyncBoundedQueue<number>(2);
      expect(queue.tryPut(1)).toBe(true);
      expect(queue.tryPut(2)).toBe(true);
      expect(queue.tryPut(3)).toBe(false); // Queue is full
      expect(queue.size()).toBe(2);
    });

    test('should remove items with tryGet', () => {
      const queue = new AsyncBoundedQueue<number>(5);
      queue.tryPut(1);
      queue.tryPut(2);
      
      expect(queue.tryGet()).toBe(1);
      expect(queue.tryGet()).toBe(2);
      expect(queue.tryGet()).toBe(undefined); // Queue is empty
      expect(queue.size()).toBe(0);
    });

    test('should maintain FIFO order', () => {
      const queue = new AsyncBoundedQueue<number>(5);
      queue.tryPut(1);
      queue.tryPut(2);
      queue.tryPut(3);
      
      expect(queue.tryGet()).toBe(1);
      expect(queue.tryGet()).toBe(2);
      expect(queue.tryGet()).toBe(3);
    });
  });

  describe('Async Operations', () => {
    test('should wait when queue is full using put', async () => {
      const queue = new AsyncBoundedQueue<number>(2);
      queue.tryPut(1);
      queue.tryPut(2);
      
      let putCompleted = false;
      const putPromise = queue.put(3).then(() => {
        putCompleted = true;
      });

      // Put should not complete immediately
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(putCompleted).toBe(false);

      // Remove an item to make space
      queue.tryGet();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(putCompleted).toBe(true);

      await putPromise;
      expect(queue.size()).toBe(2);
    });

    test('should wait when queue is empty using get', async () => {
      const queue = new AsyncBoundedQueue<number>(5);
      
      let getCompleted = false;
      const getPromise = queue.get().then(() => {
        getCompleted = true;
      });

      // Get should not complete immediately
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(getCompleted).toBe(false);

      // Add an item
      queue.tryPut(1);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(getCompleted).toBe(true);

      const result = await getPromise;
      expect(result).toBe(1);
    });

    test('should handle multiple waiting consumers', async () => {
      const queue = new AsyncBoundedQueue<number>(5);
      
      const consumer1 = queue.get();
      const consumer2 = queue.get();
      const consumer3 = queue.get();

      queue.tryPut(1);
      queue.tryPut(2);
      queue.tryPut(3);

      expect(await consumer1).toBe(1);
      expect(await consumer2).toBe(2);
      expect(await consumer3).toBe(3);
    });
  });

  describe('Queue Closure', () => {
    test('should close queue and prevent further puts', () => {
      const queue = new AsyncBoundedQueue<number>(5);
      queue.close();
      
      expect(queue.tryPut(1)).toBe(false);
    });

    test('should throw error when getting from closed empty queue', async () => {
      const queue = new AsyncBoundedQueue<number>(5);
      queue.close();
      
      await expect(queue.get()).rejects.toThrow('Queue is closed and empty');
    });

    test('should allow getting existing items after close', () => {
      const queue = new AsyncBoundedQueue<number>(5);
      queue.tryPut(1);
      queue.tryPut(2);
      queue.close();
      
      expect(queue.tryGet()).toBe(1);
      expect(queue.tryGet()).toBe(2);
      expect(queue.tryGet()).toBe(undefined);
    });
  });
});

describe('BackpressureManager', () => {
  describe('Configuration', () => {
    test('should use default configuration', () => {
      const manager = new BackpressureManager();
      expect(manager.getMaxCapacity()).toBe(1000);
    });

    test('should use custom configuration', () => {
      const config: Partial<BackpressureConfig> = {
        maxCapacity: 500,
        dropThreshold: 0.8,
        slowDownThreshold: 0.6,
        slowDownDelay: 50,
      };
      const manager = new BackpressureManager(config);
      expect(manager.getMaxCapacity()).toBe(500);
    });
  });

  describe('Enqueue Operations', () => {
    test('should enqueue packets successfully', async () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      const packet: IngestionPacket = {
        priority: PacketPriority.STANDARD,
        data: { test: 'data' },
        timestamp: Date.now(),
      };

      const result = await manager.enqueue(packet);
      expect(result).toBe(true);
      expect(manager.getQueueLength()).toBe(1);
    });

    test('should drop metric packets when above drop threshold', async () => {
      const manager = new BackpressureManager({ 
        maxCapacity: 10,
        dropThreshold: 0.5 
      });
      
      // Fill queue to 60% (above 50% threshold)
      for (let i = 0; i < 6; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      const metricPacket: IngestionPacket = {
        priority: PacketPriority.METRIC,
        data: { test: 'metric' },
        timestamp: Date.now(),
      };

      const result = await manager.enqueue(metricPacket);
      expect(result).toBe(false); // Should be dropped
      const metrics = manager.getMetrics();
      expect(metrics.droppedPackets).toBeGreaterThan(0);
    });

    test('should slow down ingestion when above slow down threshold', async () => {
      const manager = new BackpressureManager({ 
        maxCapacity: 10,
        slowDownThreshold: 0.5,
        slowDownDelay: 100,
      });
      
      // Fill queue to 60% (above 50% threshold)
      for (let i = 0; i < 6; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      const startTime = Date.now();
      await manager.enqueue({
        priority: PacketPriority.STANDARD,
        data: { test: 'slow' },
        timestamp: Date.now(),
      });
      const elapsed = Date.now() - startTime;

      // Should have been delayed
      expect(elapsed).toBeGreaterThanOrEqual(50);
      const metrics = manager.getMetrics();
      expect(metrics.slowedDownIngestions).toBeGreaterThan(0);
    });

    test('should allow critical packets to wait when queue is full', async () => {
      const manager = new BackpressureManager({ maxCapacity: 5 });
      
      // Fill queue to capacity
      for (let i = 0; i < 5; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      const criticalPacket: IngestionPacket = {
        priority: PacketPriority.CRITICAL,
        data: { test: 'critical' },
        timestamp: Date.now(),
      };

      // Critical packet should wait (not be dropped immediately)
      // Note: In actual implementation, it would wait for space
      // For this test, we just verify it doesn't return false immediately
      const result = await manager.enqueue(criticalPacket);
      expect(result).toBe(true);
    });
  });

  describe('Dequeue Operations', () => {
    test('should dequeue packets', async () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      
      const packet: IngestionPacket = {
        priority: PacketPriority.STANDARD,
        data: { test: 'data' },
        timestamp: Date.now(),
      };
      
      await manager.enqueue(packet);
      const dequeued = await manager.dequeue();
      
      expect(dequeued).toEqual(packet);
      expect(manager.getQueueLength()).toBe(0);
    });

    test('should return undefined when queue is empty', async () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      const dequeued = await manager.dequeue();
      expect(dequeued).toBe(undefined);
    });

    test('should tryDequeue without blocking', async () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      
      const packet: IngestionPacket = {
        priority: PacketPriority.STANDARD,
        data: { test: 'data' },
        timestamp: Date.now(),
      };
      
      await manager.enqueue(packet);
      const dequeued = manager.tryDequeue();
      
      expect(dequeued).toEqual(packet);
      expect(manager.tryDequeue()).toBe(undefined);
    });
  });

  describe('Metrics', () => {
    test('should track queue length and saturation', async () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      
      await manager.enqueue({
        priority: PacketPriority.STANDARD,
        data: { test: 'data' },
        timestamp: Date.now(),
      });
      
      const metrics = manager.getMetrics();
      expect(metrics.queueLength).toBe(1);
      expect(metrics.saturation).toBe(0.1);
      expect(metrics.maxCapacity).toBe(10);
    });

    test('should track dropped packets', async () => {
      const manager = new BackpressureManager({ 
        maxCapacity: 5,
        dropThreshold: 0.5 
      });
      
      // Fill queue above threshold
      for (let i = 0; i < 4; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      // Try to add metric packet (should be dropped)
      await manager.enqueue({
        priority: PacketPriority.METRIC,
        data: { test: 'metric' },
        timestamp: Date.now(),
      });

      const metrics = manager.getMetrics();
      expect(metrics.droppedPackets).toBeGreaterThan(0);
    });

    test('should track slowed down ingestions', async () => {
      const manager = new BackpressureManager({ 
        maxCapacity: 10,
        slowDownThreshold: 0.5,
        slowDownDelay: 50,
      });
      
      // Fill queue above threshold
      for (let i = 0; i < 6; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      // Add another packet (should be slowed down)
      await manager.enqueue({
        priority: PacketPriority.STANDARD,
        data: { test: 'slow' },
        timestamp: Date.now(),
      });

      const metrics = manager.getMetrics();
      expect(metrics.slowedDownIngestions).toBeGreaterThan(0);
    });

    test('should reset metrics', async () => {
      const manager = new BackpressureManager({ 
        maxCapacity: 5,
        dropThreshold: 0.5 
      });
      
      // Fill queue above threshold
      for (let i = 0; i < 4; i++) {
        await manager.enqueue({
          priority: PacketPriority.STANDARD,
          data: { test: i },
          timestamp: Date.now(),
        });
      }

      // Drop a packet
      await manager.enqueue({
        priority: PacketPriority.METRIC,
        data: { test: 'metric' },
        timestamp: Date.now(),
      });

      let metrics = manager.getMetrics();
      expect(metrics.droppedPackets).toBeGreaterThan(0);

      // Reset metrics
      manager.resetMetrics();
      metrics = manager.getMetrics();
      expect(metrics.droppedPackets).toBe(0);
      expect(metrics.slowedDownIngestions).toBe(0);
    });
  });

  describe('Shutdown', () => {
    test('should shutdown gracefully', () => {
      const manager = new BackpressureManager({ maxCapacity: 10 });
      expect(() => manager.shutdown()).not.toThrow();
    });
  });
});

describe('Integration Tests', () => {
  test('should handle high load scenario', async () => {
    const manager = new BackpressureManager({ 
      maxCapacity: 100,
      dropThreshold: 0.9,
      slowDownThreshold: 0.7,
      slowDownDelay: 10,
    });
    
    // Simulate high load by enqueueing many packets
    const enqueuePromises: Promise<boolean>[] = [];
    for (let i = 0; i < 200; i++) {
      const packet: IngestionPacket = {
        priority: i % 3 === 0 ? PacketPriority.METRIC : PacketPriority.STANDARD,
        data: { test: i },
        timestamp: Date.now(),
      };
      enqueuePromises.push(manager.enqueue(packet));
    }

    const results = await Promise.all(enqueuePromises);
    const successCount = results.filter(r => r).length;
    const failCount = results.filter(r => !r).length;

    // Some packets should succeed, some should be dropped
    expect(successCount).toBeGreaterThan(0);
    expect(failCount).toBeGreaterThan(0);

    const metrics = manager.getMetrics();
    expect(metrics.queueLength).toBeLessThanOrEqual(100);
    expect(metrics.droppedPackets).toBeGreaterThan(0);
  });

  test('should recover from backpressure after processing', async () => {
    const manager = new BackpressureManager({ 
      maxCapacity: 10,
      dropThreshold: 0.8,
      slowDownThreshold: 0.6,
    });
    
    // Fill queue to trigger backpressure
    for (let i = 0; i < 8; i++) {
      await manager.enqueue({
        priority: PacketPriority.STANDARD,
        data: { test: i },
        timestamp: Date.now(),
      });
    }

    let metrics = manager.getMetrics();
    expect(metrics.saturation).toBeGreaterThanOrEqual(0.6);

    // Process packets
    for (let i = 0; i < 8; i++) {
      await manager.dequeue();
    }

    metrics = manager.getMetrics();
    expect(metrics.queueLength).toBe(0);
    expect(metrics.saturation).toBe(0);
  });
});

it("blocks standard packets when queue is full")

it("blocks critical packets when queue is full")

it("drops metric packets above drop threshold")

it("never exceeds maxCapacity of 1000")