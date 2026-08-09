export async function mapSettledSerial<T, R>(items: readonly T[], task: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];

    for (let index = 0; index < items.length; index += 1) {
        try {
            results.push({ status: "fulfilled", value: await task(items[index], index) });
        } catch (reason) {
            results.push({ status: "rejected", reason });
        }
    }

    return results;
}
