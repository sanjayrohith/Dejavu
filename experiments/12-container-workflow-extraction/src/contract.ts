export const TERMINAL_STATUSES = new Set(["done", "completed", "failed"]);

export function extractionBody(marker: string) {
  return {
    content: `Experiment 12 synthetic extraction. Unique marker: ${marker}. The durable receipt must preserve this exact marker.`,
    customId: marker,
    metadata: { experiment: "12", marker }
  };
}

export function assertMarker(marker: unknown): asserts marker is string {
  if (typeof marker !== "string" || !/^exp12-[a-zA-Z0-9-]{8,120}$/.test(marker)) {
    throw new Error("marker must be unique and match exp12-[a-zA-Z0-9-]{8,120}");
  }
}
