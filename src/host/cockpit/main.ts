import { parseArgs } from 'node:util';
import { startCockpit } from './server.js';

const USAGE = `Usage:
  npm run cockpit -- --runs-root <abs-dir> --provider-home <abs-dir> --gateway-charter <abs-path> [--port <port>]

Binds 127.0.0.1 only. The bearer token file path is printed; the token is not.
`;

function valueOf(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      'runs-root': { type: 'string' },
      'provider-home': { type: 'string' },
      'gateway-charter': { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const runsRoot = valueOf(parsed.values, 'runs-root');
  const providerHome = valueOf(parsed.values, 'provider-home');
  const gatewayCharter = valueOf(parsed.values, 'gateway-charter');
  let port: number | undefined;
  if (parsed.values.port !== undefined) {
    if (typeof parsed.values.port !== 'string' || !/^[0-9]+$/.test(parsed.values.port)) {
      throw new Error('--port must be a decimal port');
    }
    port = Number(parsed.values.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('--port must be between 1 and 65535');
    }
  }
  const cockpit = await startCockpit({
    runsRoot, providerHome, gatewayCharter,
    ...(port !== undefined ? { port } : {}),
  });
  process.stdout.write(`cockpit: ${cockpit.url}\ntoken: ${cockpit.tokenPath}\n`);
  const close = (): void => {
    void cockpit.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((err: unknown) => {
  process.stderr.write(`cockpit: ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
