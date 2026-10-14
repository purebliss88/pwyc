// Runs once a day and deletes expired PWYC codes from Squarespace.
// It only ever touches codes that start with your PWYC prefix.
import { cleanupExpired } from "../lib/pwyc-core.mjs";

export default async () => {
  await cleanupExpired(process.env);
};

export const config = { schedule: "@daily" };
