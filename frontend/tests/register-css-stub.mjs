/*
 * Registers the stylesheet stub loader for the Node test runner.
 * Used as `--import ./tests/register-css-stub.mjs`.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./css-stub-loader.mjs', pathToFileURL(import.meta.filename));
