import type { ArcClient } from './arcClient';
import { toast } from 'svelte-sonner';

export type AlertCondition = 'greater_than' | 'less_than' | 'equals' | 'not_equals' | 'contains';

export interface Alert {
  id: string;
  name: string;
  query: string;
  condition: AlertCondition;
  threshold: number | string;
  checkIntervalMs: number;
  enabled: boolean;
  lastCheck?: number;
  lastResult?: any;
  lastError?: string;
  triggeredCount: number;
  createdAt: number;
}

export interface AlertTrigger {
  alertId: string;
  alertName: string;
  timestamp: number;
  value: any;
  message: string;
}

export type CreateAlertInput = Omit<Alert, 'id' | 'triggeredCount' | 'createdAt' | 'lastCheck' | 'lastResult' | 'lastError'>;

const ALERTS_STORAGE_KEY = 'arc.alerts';
const TRIGGERS_STORAGE_KEY = 'arc.alertTriggers';
const MAX_TRIGGER_HISTORY = 100;
const MIN_CHECK_INTERVAL_MS = 10000; // 10 seconds

export class AlertManager {
  private alerts: Alert[] = [];
  private triggers: AlertTrigger[] = [];
  private timers: Map<string, number> = new Map();
  private listeners: Set<() => void> = new Set();

  constructor(private getClient: () => ArcClient | null) {
    this.loadAlerts();
    this.loadTriggers();
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }

  // CRUD operations
  createAlert(input: CreateAlertInput): Alert {
    const alert: Alert = {
      ...input,
      id: crypto.randomUUID(),
      checkIntervalMs: Math.max(input.checkIntervalMs, MIN_CHECK_INTERVAL_MS),
      triggeredCount: 0,
      createdAt: Date.now()
    };

    this.alerts.push(alert);
    this.saveAlerts();

    if (alert.enabled) {
      this.startAlert(alert);
    }

    // Request notification permission on first alert creation
    this.requestNotificationPermission();

    this.notifyListeners();
    return alert;
  }

  updateAlert(id: string, updates: Partial<CreateAlertInput>): Alert | null {
    const index = this.alerts.findIndex(a => a.id === id);
    if (index === -1) return null;

    const alert = this.alerts[index];
    const wasEnabled = alert.enabled;

    // Apply updates
    Object.assign(alert, updates);

    // Ensure minimum interval
    if (updates.checkIntervalMs !== undefined) {
      alert.checkIntervalMs = Math.max(alert.checkIntervalMs, MIN_CHECK_INTERVAL_MS);
    }

    this.saveAlerts();

    // Restart timer if interval changed or enabled state changed
    if (wasEnabled) {
      this.stopAlert(id);
    }
    if (alert.enabled) {
      this.startAlert(alert);
    }

    this.notifyListeners();
    return alert;
  }

  deleteAlert(id: string): boolean {
    const index = this.alerts.findIndex(a => a.id === id);
    if (index === -1) return false;

    this.stopAlert(id);
    this.alerts.splice(index, 1);
    this.saveAlerts();
    this.notifyListeners();
    return true;
  }

  getAlerts(): Alert[] {
    return [...this.alerts];
  }

  getAlert(id: string): Alert | undefined {
    return this.alerts.find(a => a.id === id);
  }

  // Enable/disable
  enableAlert(id: string): void {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert || alert.enabled) return;

    alert.enabled = true;
    this.saveAlerts();
    this.startAlert(alert);
    this.notifyListeners();
  }

  disableAlert(id: string): void {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert || !alert.enabled) return;

    alert.enabled = false;
    this.saveAlerts();
    this.stopAlert(id);
    this.notifyListeners();
  }

  toggleAlert(id: string): void {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert) return;

    if (alert.enabled) {
      this.disableAlert(id);
    } else {
      this.enableAlert(id);
    }
  }

  // Test alert (dry-run)
  async testAlert(id: string): Promise<{ value: any; wouldTrigger: boolean; error?: string }> {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert) {
      return { value: null, wouldTrigger: false, error: 'Alert not found' };
    }

    const client = this.getClient();
    if (!client) {
      return { value: null, wouldTrigger: false, error: 'Not connected to server' };
    }

    try {
      const result = await client.query(alert.query);
      if (!result.rows || result.rows.length === 0) {
        return { value: null, wouldTrigger: false, error: 'Query returned no results' };
      }

      const value = result.rows[0][0];
      const wouldTrigger = this.evaluateCondition(value, alert.condition, alert.threshold);
      return { value, wouldTrigger };
    } catch (err) {
      return { value: null, wouldTrigger: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  // Triggers
  getTriggers(): AlertTrigger[] {
    return [...this.triggers].reverse(); // Most recent first
  }

  getTriggersForAlert(alertId: string): AlertTrigger[] {
    return this.triggers.filter(t => t.alertId === alertId).reverse();
  }

  clearTriggers(): void {
    this.triggers = [];
    this.saveTriggers();
    this.notifyListeners();
  }

  // Cleanup
  stopAll(): void {
    this.timers.forEach((_, id) => this.stopAlert(id));
  }

  // Start all enabled alerts (call after reconnection)
  startAll(): void {
    this.alerts.filter(a => a.enabled).forEach(alert => {
      if (!this.timers.has(alert.id)) {
        this.startAlert(alert);
      }
    });
  }

  // Private methods
  private startAlert(alert: Alert): void {
    // Clear existing timer if any
    this.stopAlert(alert.id);

    // Run check immediately
    this.checkAlert(alert);

    // Start interval timer
    const timer = window.setInterval(() => {
      this.checkAlert(alert);
    }, alert.checkIntervalMs);

    this.timers.set(alert.id, timer);
  }

  private stopAlert(alertId: string): void {
    const timer = this.timers.get(alertId);
    if (timer !== undefined) {
      window.clearInterval(timer);
      this.timers.delete(alertId);
    }
  }

  private async checkAlert(alert: Alert): Promise<void> {
    const client = this.getClient();
    if (!client) {
      alert.lastCheck = Date.now();
      alert.lastError = 'Not connected';
      this.saveAlerts();
      this.notifyListeners();
      return;
    }

    try {
      const result = await client.query(alert.query);
      alert.lastCheck = Date.now();
      alert.lastError = undefined;

      if (!result.rows || result.rows.length === 0) {
        alert.lastResult = null;
        this.saveAlerts();
        this.notifyListeners();
        return;
      }

      const value = result.rows[0][0];
      alert.lastResult = value;

      const triggered = this.evaluateCondition(value, alert.condition, alert.threshold);

      if (triggered) {
        alert.triggeredCount++;
        const trigger = this.createTrigger(alert, value);
        this.showNotification(alert, trigger);
      }

      this.saveAlerts();
      this.notifyListeners();
    } catch (err) {
      alert.lastCheck = Date.now();
      alert.lastError = err instanceof Error ? err.message : 'Query failed';
      this.saveAlerts();
      this.notifyListeners();
    }
  }

  private evaluateCondition(value: any, condition: AlertCondition, threshold: number | string): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    switch (condition) {
      case 'greater_than':
        return Number(value) > Number(threshold);
      case 'less_than':
        return Number(value) < Number(threshold);
      case 'equals':
        return value == threshold;
      case 'not_equals':
        return value != threshold;
      case 'contains':
        return String(value).toLowerCase().includes(String(threshold).toLowerCase());
      default:
        return false;
    }
  }

  private createTrigger(alert: Alert, value: any): AlertTrigger {
    const conditionText = this.formatCondition(alert.condition);
    const trigger: AlertTrigger = {
      alertId: alert.id,
      alertName: alert.name,
      timestamp: Date.now(),
      value,
      message: `${alert.name}: ${value} ${conditionText} ${alert.threshold}`
    };

    this.triggers.push(trigger);

    // Keep only last N triggers
    if (this.triggers.length > MAX_TRIGGER_HISTORY) {
      this.triggers = this.triggers.slice(-MAX_TRIGGER_HISTORY);
    }

    this.saveTriggers();
    return trigger;
  }

  private formatCondition(condition: AlertCondition): string {
    switch (condition) {
      case 'greater_than': return '>';
      case 'less_than': return '<';
      case 'equals': return '=';
      case 'not_equals': return '!=';
      case 'contains': return 'contains';
      default: return condition;
    }
  }

  private showNotification(alert: Alert, trigger: AlertTrigger): void {
    // Try browser notification first
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`Alert: ${alert.name}`, {
        body: trigger.message,
        icon: '/favicon.ico',
        tag: `alert-${alert.id}` // Prevents duplicate notifications
      });
    }

    // Always show toast as well
    toast.warning(trigger.message, {
      duration: 10000,
      action: {
        label: 'View',
        onClick: () => {
          // Could dispatch an event to navigate to alerts view
        }
      }
    });
  }

  private requestNotificationPermission(): void {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // Persistence
  private loadAlerts(): void {
    try {
      const stored = localStorage.getItem(ALERTS_STORAGE_KEY);
      if (stored) {
        this.alerts = JSON.parse(stored);
        // Start enabled alerts
        this.alerts.filter(a => a.enabled).forEach(alert => {
          this.startAlert(alert);
        });
      }
    } catch (err) {
      console.error('Failed to load alerts:', err);
      this.alerts = [];
    }
  }

  private saveAlerts(): void {
    try {
      localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(this.alerts));
    } catch (err) {
      console.error('Failed to save alerts:', err);
    }
  }

  private loadTriggers(): void {
    try {
      const stored = localStorage.getItem(TRIGGERS_STORAGE_KEY);
      if (stored) {
        this.triggers = JSON.parse(stored);
      }
    } catch (err) {
      console.error('Failed to load triggers:', err);
      this.triggers = [];
    }
  }

  private saveTriggers(): void {
    try {
      localStorage.setItem(TRIGGERS_STORAGE_KEY, JSON.stringify(this.triggers));
    } catch (err) {
      console.error('Failed to save triggers:', err);
    }
  }
}

// Helper to format interval for display
export function formatIntervalMs(ms: number): string {
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  } else if (ms < 3600000) {
    return `${Math.round(ms / 60000)}m`;
  } else {
    return `${Math.round(ms / 3600000)}h`;
  }
}

// Helper to parse interval string to ms
export function parseIntervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return MIN_CHECK_INTERVAL_MS;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return MIN_CHECK_INTERVAL_MS;
  }
}
