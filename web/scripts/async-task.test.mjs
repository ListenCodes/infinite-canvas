import assert from "node:assert/strict";
import test from "node:test";

import { mapSettledSerial } from "../src/lib/async-task.ts";

test("serial task mapping never runs more than one task at once", async () => {
    let active = 0;
    let maximumActive = 0;
    const started = [];

    const results = await mapSettledSerial([1, 2, 3], async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(value);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
    });

    assert.equal(maximumActive, 1);
    assert.deepEqual(started, [1, 2, 3]);
    assert.deepEqual(results, [
        { status: "fulfilled", value: 2 },
        { status: "fulfilled", value: 4 },
        { status: "fulfilled", value: 6 },
    ]);
});

test("serial task mapping continues after a rejected task", async () => {
    const visited = [];
    const failure = new Error("failed");

    const results = await mapSettledSerial([1, 2, 3], async (value) => {
        visited.push(value);
        if (value === 2) throw failure;
        return value;
    });

    assert.deepEqual(visited, [1, 2, 3]);
    assert.deepEqual(results, [
        { status: "fulfilled", value: 1 },
        { status: "rejected", reason: failure },
        { status: "fulfilled", value: 3 },
    ]);
});
