import type { z } from "zod";
import { ValidationError } from "../domain/errors.js";

/**
 * Parse request input with zod, turning failures into a ValidationError (400)
 * that lists every problem, so clients get one consistent error shape.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, where: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid ${where}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), problem: i.message })),
    });
  }
  return result.data;
}
