import type { Redis } from 'ioredis';

type Listener = (message: string) => void;

/**
 * Fans Redis pub/sub messages out to in-process listeners (one per open event stream). One subscriber
 * connection serves every stream; a channel stays subscribed while anyone listens to it.
 */
export class EventHub {
  private listeners = new Map<string, Set<Listener>>();

  constructor(private subscriber: Redis) {
    subscriber.on('message', (channel: string, message: string) => {
      for (const listener of this.listeners.get(channel) ?? []) listener(message);
    });
  }

  /** Resolves once Redis confirms the subscription, so no message published after it is missed. */
  async subscribe(channel: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    await this.subscriber.subscribe(channel);

    return async () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(channel) === set) {
        this.listeners.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  /** Channels with listeners; for tests and diagnostics. */
  get channels(): string[] {
    return [...this.listeners.keys()];
  }
}
