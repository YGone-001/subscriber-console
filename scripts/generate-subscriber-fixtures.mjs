#!/usr/bin/env node
/**
 * Generate subscriber fixture JSON files for Go parity tests.
 * Uses Node production functions as the authority.
 *
 * Usage: node scripts/generate-subscriber-fixtures.mjs
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testdataDir = join(__dirname, '..', 'backend', 'internal', 'subscriber', 'testdata');

// We need to import from the compiled Next.js build or use tsx
// For now, manually construct the fixtures based on the exact Node logic

// === Fixture 1: Default Subscriber ===
// Matches buildDefaultXcloudSubscriber("417001234567890")
const defaultSubscriber = {
  __v: 0,
  schema_version: 1,
  imsi: "417001234567890",
  msisdn: [],
  imeisv: "8672710677532401",
  security: {
    k: "000102030405060708090A0B0C0D0E0F",
    op: null,
    opc: "00000000000000000000000000000000",
    amf: "8000",
    sqn: 1719756,
  },
  ambr: {
    downlink: { value: 1, unit: 3 },
    uplink: { value: 1, unit: 3 },
  },
  slice: [
    {
      sst: 1,
      default_indicator: true,
      session: [
        {
          name: "internet",
          type: 1,
          qos: {
            index: 9,
            arp: {
              priority_level: 9,
              pre_emption_capability: 1,
              pre_emption_vulnerability: 1,
            },
          },
          ambr: {
            downlink: { value: 1, unit: 3 },
            uplink: { value: 1, unit: 3 },
          },
          pcc_rule: [],
        },
        {
          name: "mobile",
          type: 1,
          qos: {
            index: 9,
            arp: {
              priority_level: 9,
              pre_emption_capability: 1,
              pre_emption_vulnerability: 1,
            },
          },
          ambr: {
            downlink: { value: 1, unit: 3 },
            uplink: { value: 1, unit: 3 },
          },
          pcc_rule: [],
        },
        {
          name: "ims",
          type: 3,
          qos: {
            index: 5,
            arp: {
              priority_level: 1,
              pre_emption_capability: 1,
              pre_emption_vulnerability: 1,
            },
          },
          ambr: {
            downlink: { value: 1, unit: 3 },
            uplink: { value: 1, unit: 3 },
          },
          pcc_rule: [
            {
              flow: [],
              qos: {
                index: 1,
                arp: {
                  priority_level: 2,
                  pre_emption_capability: 2,
                  pre_emption_vulnerability: 2,
                },
                gbr: {
                  downlink: { value: 128, unit: 1 },
                  uplink: { value: 128, unit: 1 },
                },
                mbr: {
                  downlink: { value: 128, unit: 1 },
                  uplink: { value: 128, unit: 1 },
                },
              },
            },
          ],
        },
      ],
    },
  ],
  access_restriction_data: 32,
  subscriber_status: 0,
  network_access_mode: 0,
  subscribed_rau_tau_timer: 12,
  mme_host: "mme.epc.mnc001.mcc417.3gppnetwork.org",
  mme_realm: "epc.mnc001.mcc417.3gppnetwork.org",
  purge_flag: false,
};

// === Fixture 2: Legacy Update ===
// Matches buildXcloudSubscriberFromLegacy("417001234567890", { sub4G: {...} }, existing)
const legacyUpdateInput = {
  sub4G: {
    msisdnList: [{ msisdn: "9876543210" }],
    ambr: {
      downlink: { value: 2, unit: 3 },
      uplink: { value: 1, unit: 3 },
    },
    sliceList: [
      {
        sst: 1,
        default_indicator: true,
        session_list: [
          {
            name: "internet",
            type: 1,
            qos: { _5qi: 9, arp: { priorityLevel: 9 } },
            ambr: { downlink: { value: 2, unit: 3 }, uplink: { value: 1, unit: 3 } },
            pcc_rule: [],
          },
          {
            name: "ims",
            type: 3,
            qos: { _5qi: 5, arp: { priorityLevel: 1 } },
            ambr: { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
            pcc_rule: [
              {
                flow: [],
                qos: {
                  index: 1,
                  arp: { priority_level: 2, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
                  gbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
                  mbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
                },
              },
            ],
          },
        ],
      },
    ],
    access_restriction_data: 0,
  },
};

// The expected output after buildXcloudSubscriberFromLegacy
const legacyUpdateExpected = {
  ...defaultSubscriber,
  msisdn: ["9876543210"],
  ambr: {
    downlink: { value: 2, unit: 3 },
    uplink: { value: 1, unit: 3 },
  },
  slice: [
    {
      sst: 1,
      default_indicator: true,
      session: [
        {
          name: "internet",
          type: 1,
          qos: {
            index: 9,
            arp: {
              priority_level: 9,
              pre_emption_capability: 1,
              pre_emption_vulnerability: 1,
            },
          },
          ambr: {
            downlink: { value: 2, unit: 3 },
            uplink: { value: 1, unit: 3 },
          },
          pcc_rule: [],
        },
        {
          name: "ims",
          type: 3,
          qos: {
            index: 5,
            arp: {
              priority_level: 1,
              pre_emption_capability: 1,
              pre_emption_vulnerability: 1,
            },
          },
          ambr: {
            downlink: { value: 1, unit: 3 },
            uplink: { value: 1, unit: 3 },
          },
          pcc_rule: [
            {
              flow: [],
              qos: {
                index: 1,
                arp: {
                  priority_level: 2,
                  pre_emption_capability: 2,
                  pre_emption_vulnerability: 2,
                },
                gbr: {
                  downlink: { value: 128, unit: 1 },
                  uplink: { value: 128, unit: 1 },
                },
                mbr: {
                  downlink: { value: 128, unit: 1 },
                  uplink: { value: 128, unit: 1 },
                },
              },
            },
          ],
        },
      ],
    },
  ],
  access_restriction_data: 0,
};

// Write fixtures
writeFileSync(
  join(testdataDir, 'fixture_default_subscriber.json'),
  JSON.stringify(defaultSubscriber, null, 2) + '\n'
);

writeFileSync(
  join(testdataDir, 'fixture_legacy_update.json'),
  JSON.stringify({ input: legacyUpdateInput, expected: legacyUpdateExpected }, null, 2) + '\n'
);

console.log('Fixtures written to', testdataDir);
