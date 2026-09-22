/**
 * Load `.env` from the working directory when present (Node >= 20.12). Variables that are already set in the
 * real environment always win, so production deployments can rely on their process manager's environment.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: fine, configuration comes from the real environment.
  }
}
