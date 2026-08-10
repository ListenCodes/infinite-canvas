export class OrderedPersistQueue<T> {
    #pending: T | undefined;
    #tail: Promise<void> = Promise.resolve();

    queue(value: T): void {
        this.#pending = value;
    }

    flush(write: (value: T) => Promise<void>): Promise<void> {
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending === undefined) return this.#tail;
        const operation = this.#tail.catch(() => undefined).then(() => write(pending));
        this.#tail = operation;
        return operation;
    }
}
