import { generationEventSchema, type GenerationEvent } from "@infinite-canvas/contracts";

export function buildCloudEventRequest(projectId: string, cursor: string) {
    const query = new URLSearchParams({ projectId, cursor });
    return {
        path: `/v1/events?${query.toString()}`,
        headers: { Accept: "text/event-stream", "Last-Event-ID": cursor },
    };
}

export function newerEventCursor(current: string, candidate: string): string {
    return BigInt(candidate) > BigInt(current) ? candidate : current;
}

export class GenerationEventDecoder {
    #buffer = "";
    #cursor: bigint;

    constructor(cursor: string) {
        this.#cursor = BigInt(cursor);
    }

    get cursor(): string {
        return this.#cursor.toString();
    }

    push(chunk: string): GenerationEvent[] {
        this.#buffer += chunk;
        const frames = this.#buffer.split(/(?:\r\n|\r|\n){2}/);
        this.#buffer = frames.pop() ?? "";
        const events: GenerationEvent[] = [];
        for (const frame of frames) {
            const data = frame
                .split(/\r\n|\r|\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
            if (!data) continue;
            let value: unknown;
            try {
                value = JSON.parse(data);
            } catch {
                continue;
            }
            const parsed = generationEventSchema.safeParse(value);
            if (!parsed.success || BigInt(parsed.data.sequence) <= this.#cursor) continue;
            this.#cursor = BigInt(parsed.data.sequence);
            events.push(parsed.data);
        }
        return events;
    }
}
