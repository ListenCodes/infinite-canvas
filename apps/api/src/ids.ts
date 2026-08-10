import { v7 as uuidv7 } from "uuid";

export type IdFactory = () => string;

export const createId: IdFactory = uuidv7;
