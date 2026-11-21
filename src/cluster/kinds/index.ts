export async function loadGhostKinds(): Promise<void> {
  const { registerObjectGhosts } = await import("./objects");
  registerObjectGhosts();
}
