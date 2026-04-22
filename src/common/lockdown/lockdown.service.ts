class LockdownService {
  private isLocked = false;

  enable() {
    this.isLocked = true;
    console.warn("[LOCKDOWN] Emergency lockdown ENABLED");
  }

  disable() {
    this.isLocked = false;
    console.info("[LOCKDOWN] Lockdown disabled");
  }

  toggle() {
    this.isLocked = !this.isLocked;
    console.warn(`[LOCKDOWN] Toggled → ${this.isLocked ? "ON" : "OFF"}`);
    return this.isLocked;
  }

  status() {
    return this.isLocked;
  }

  assertNotLocked() {
    if (this.isLocked) {
      throw new Error("System is in emergency lockdown. Transactions are disabled.");
    }
  }
}

export const lockdownService = new LockdownService();
