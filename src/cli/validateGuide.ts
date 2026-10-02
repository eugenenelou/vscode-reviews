import { readFileSync } from "node:fs";
import { parseGuide } from "../core/guide";

/** The reason a guide file's text is invalid, or undefined when it parses. */
export function guideError(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return `invalid JSON: ${(error as Error).message}`;
  }
  try {
    parseGuide("", json);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: validate-guide <guide.json>");
    process.exit(2);
  }
  const error = guideError(readFileSync(path, "utf8"));
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
