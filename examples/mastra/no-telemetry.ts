// Mastra sends anonymous feature telemetry (posthog) unless this is set. Import first in tests.
process.env.MASTRA_TELEMETRY_DISABLED ??= '1'
export {}
