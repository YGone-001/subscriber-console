/**
 * Register custom loader for @/ path alias resolution.
 * Use with: node --import ./scripts/register-paths.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL('./scripts/ts-loader.mjs').href);
