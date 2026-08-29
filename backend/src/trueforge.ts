import { TrueForge } from '@truefoundry/trueforge-sdk';
import dotenv from 'dotenv';

dotenv.config();

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

export const trueforge = new TrueForge({
  baseUrl,
  timeoutInSeconds: 600, // long SSE streams
});

/** The saved agent name registered in TrueForge. */
export const AGENT_NAME = 'sentinel-prod-v1';
