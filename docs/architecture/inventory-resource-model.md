# Inventory / Resource Model Architecture Specification

## 1. Architectural Authority and Boundary

The Inventory Domain establishes the platform source of truth for telecom and cloud resource metadata within the xCloud OSS/NMS platform.

```text
Operator / UI (React SPA)
           |
           v
    Inventory API (Go :18888)
           |
           v
    Inventory Domain (Validation, CAS, Keyset Pagination)
           |
           v
xcloud_ops.app_inventory_resources
```

### 1.1 Scope and Responsibility
- **Authoritative for**: Resource facts, classification, software metadata, management coordinates, operational lifecycle state, administrative tags, and server-owned provenance.
- **NOT Authoritative for**: Live network health, dynamic telemetry, configuration execution, topology graph relationships, device discovery, remote CLI/SSH/NETCONF actuation, or fault alarm states.

### 1.2 Database and Collection Placement
- All inventory resource records are persisted exclusively in:
  `xcloud_ops.app_inventory_resources`
- Inventory collections in `xcloud` (the telecom subscriber / HSS / OCS database): **0**.
- Zero schema or record cross-contamination with `xcloud.subscribers` or OCS domain tables.

---

## 2. Persistence Model & MongoDB Indexes

### 2.1 Collection Name
`xcloud_ops.app_inventory_resources`

### 2.2 Authoritative Indexes
The following indexes are provisioned on `xcloud_ops.app_inventory_resources`:
1. `inventory_kind_domain_lifecycle_updated`: `{ kind: 1, domain: 1, lifecycleState: 1, updatedAt: -1 }`
   Optimizes filtered queries and multi-field administrative views.
2. `inventory_name_normalized_updated`: `{ nameNormalized: 1, updatedAt: -1 }`
   Optimizes case-insensitive resource prefix searches.
3. `inventory_updated_id`: `{ updatedAt: -1, _id: 1 }`
   Supports keyset cursor pagination with deterministic ordering.
4. `uniq_inventory_source_external_id`: `{ "source.system": 1, "source.externalId": 1 }`, `unique: true`, `partialFilterExpression: { "source.externalId": { $exists: true, $type: "string", $gt: "" } }`
   Enforces uniqueness for external system provenance identifiers when non-empty externalId is present (not sparse).

Note: `_id` stores the canonical resourceId UUID string directly; no separate `resourceId` index is maintained.

---

## 3. Resource Model Specification

### 3.1 Field Taxonomy
| Field | Type | Mutability | Constraints & Semantics |
| :--- | :--- | :--- | :--- |
| `resourceId` | string (UUID v4) | Immutable | Server-generated upon creation (`_id`). Strict RFC 4122 v4 regex. |
| `schemaVersion` | int | Immutable | Constant `1`. |
| `kind` | string | Immutable | Must be one of the 20 canonical kinds. Immutable across updates. |
| `name` | string | Mutable | Length 1..128, matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. |
| `nameNormalized` | string | Server-owned | Lowercase `name` for indexed prefix lookups. |
| `displayName` | string | Mutable | Optional human-readable display name (max 256 chars). |
| `description` | string | Mutable | Optional text description (max 1024 chars). |
| `domain` | string | Mutable | Must be one of the 10 canonical telecom domains. |
| `role` | string | Mutable | Optional role qualifier (max 64 chars). |
| `lifecycleState` | string | Governed | One of: `planned`, `active`, `maintenance`, `retired`. |
| `vendor` | string | Mutable | Optional hardware or software vendor (max 128 chars). |
| `model` | string | Mutable | Optional equipment model (max 128 chars). |
| `software` | object | Mutable | Optional product, version, and build metadata. |
| `managementEndpoints` | array | Mutable | Up to 16 management endpoint descriptors. |
| `capabilities` | array | Mutable | Up to 64 normalized capability strings. |
| `labels` | object | Mutable | Up to 32 key-value administrative tags. |
| `attributes` | object | Mutable | Bounded JSON object (max 32 KiB, max depth 6). |
| `source` | object | Server-owned | Provenance (`kind`, `system`, `authority`, optional `externalId`). |
| `revision` | int64 | Server-owned | Monotonic CAS revision counter, initialized to 1. |
| `createdAt` | string (ISO 8601) | Server-owned | UTC timestamp of initial registration. |
| `createdBy` | string | Server-owned | Authenticated username who created the resource. |
| `updatedAt` | string (ISO 8601) | Server-owned | UTC timestamp of last modification. |
| `updatedBy` | string | Server-owned | Authenticated username who performed last modification. |

### 3.2 Canonical Kinds (20)
1. `region`
2. `site`
3. `cluster`
4. `host`
5. `virtual_machine`
6. `container`
7. `pod`
8. `network_element`
9. `network_function`
10. `network_function_instance`
11. `interface`
12. `ip_address`
13. `service_endpoint`
14. `plmn`
15. `dnn`
16. `network_slice`
17. `service`
18. `configuration`
19. `software_version`
20. `deployment`

Vendor and functional identities belong in `role` or `software`, not the canonical kind taxonomy.

### 3.3 Canonical Telecom Domains (10)
1. `platform`
2. `ran`
3. `epc`
4. `ims`
5. `5gc`
6. `charging`
7. `transport`
8. `cloud`
9. `shared`
10. `other`

### 3.4 Lifecycle States (4)
- `planned`: Resource planned or provisioned but not yet carrying operational traffic.
- `active`: Resource fully operational and carrying production workload.
- `maintenance`: Resource temporarily cordoned or undergoing administrative maintenance.
- `retired`: Terminal state. Resource decommissioned and permanently frozen.

#### Terminal Retirement Rules:
- Creating a resource directly in `retired` state is rejected with HTTP 400.
- Updating an active resource into `retired` state via PUT is rejected with HTTP 400.
- Retirement must occur through the dedicated `POST /api/inventory/resources/{resourceId}/retire` endpoint.
- Once retired, any subsequent update or retirement attempt returns HTTP 409 Conflict.
- Retired resources remain readable via GET queries for historical traceability. Hard deletion is not implemented.

### 3.5 Management Endpoints
- Maximum 16 management endpoints per resource.
- Canonical protocols: `http`, `https`, `ssh`, `snmp`, `netconf`, `restconf`, `gnmi`, `sbi`, `sip`, `diameter`, `pfcp`, `gtp`, `ngap`, `other`.
- Canonical address types: `ipv4`, `ipv6`, `fqdn`.
- Strict address validation:
  - Address must be plain IP or FQDN; URL schemes (`https://`) and credentials (`user@`) are forbidden.
  - IP family must match address type (IPv4 format for `ipv4`, IPv6 format for `ipv6`).
  - FQDN must match standard DNS hostname syntax.
  - Port must be between 1 and 65535.
  - Duplicate `(protocol, address, port, path)` tuples on the same resource are rejected.

### 3.6 Recursive Attribute Validation and Sensitive-Key Rejection
- Attributes payload serialized size must not exceed 32 KiB.
- Maximum nesting depth: 6 levels.
- Total key count across all nesting levels: max 128 keys.
- Array lengths: max 128 elements.
- String value lengths: max 2048 characters.
- MongoDB operator injection prevention: Attribute keys must not contain `.` or begin with `$`.
- Sensitive key rejection: Any attribute key containing case-insensitive fragments matching `password`, `passwd`, `secret`, `token`, `apikey`, `privatekey`, or `credential` is rejected with HTTP 400 before persistence.

### 3.7 Provenance and Client Spoofing Prevention
Every resource has server-assigned source provenance:
```json
{
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  }
}
```
Client attempts to inject `resourceId`, `schemaVersion`, `source`, `revision`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `retiredAt`, `retiredBy`, or `retireReason` in request payloads or nested update bodies are rejected with HTTP 400 (`SERVER_OWNED_FIELD_FORBIDDEN`).

### 3.8 Strict JSON Request Decoding
All inventory mutation endpoints (`POST /api/inventory/resources`, `PUT /api/inventory/resources/{resourceId}`, `POST /api/inventory/resources/{resourceId}/retire`) enforce strict JSON decoding:
- Reusable standard-library decoder with `DisallowUnknownFields()`.
- Explicit EOF verification ensuring no trailing JSON values or garbage tokens.
- Request body size bounds enforced via `http.MaxBytesReader` (1 MiB).
- Unknown top-level fields, unknown nested struct fields, and trailing content return HTTP 400 (`MALFORMED_JSON` / `UNKNOWN_FIELD`).
- Rejected mutations persist 0 changes in MongoDB and record 0 audit logs.

### 3.9 Concurrency Control (CAS) & Update Replacement
- Every resource document carries a monotonic `revision` integer (initialized to 1).
- Mutations require `expectedRevision` (integer >= 1) in the request body.
- `PUT /api/inventory/resources/{resourceId}` is a full mutable replacement requiring `expectedRevision` and `resource` with non-empty `kind`, `name`, `domain`, and `lifecycleState` (`retired` rejected).
- `kind` is immutable across updates; attempting to alter `kind` returns HTTP 400.
- Updates execute atomic CAS query: `{ _id: id, revision: expectedRevision }`.
- On revision mismatch, the server returns HTTP 409 Conflict (`INVENTORY_REVISION_CONFLICT`).

### 3.10 Strict RFC 4122 UUID v4 Validation
All resource path parameters enforce strict RFC 4122 UUID v4 format matching:
`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`
- Malformed identifiers and non-v4 UUIDs return HTTP 400 (`INVALID_RESOURCE_ID`).
- Valid UUID v4 identifiers not matching any database document return HTTP 404 (`INVENTORY_RESOURCE_NOT_FOUND`).

---

## 4. API Surface & Authorization

### 4.1 Route Authority (Go Registrations)
All 6 inventory endpoints are Go-owned and registered on `ServeMux`:

| Method | Path | Required Permission | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/inventory/meta` | `core.read` | Metadata reflection for kinds, domains, lifecycles, and protocols. |
| `GET` | `/api/inventory/resources` | `core.read` | Keyset-paginated resource list with query filters. |
| `GET` | `/api/inventory/resources/{resourceId}` | `core.read` | Single resource detail by UUID. |
| `POST` | `/api/inventory/resources` | `core.configure` | Create new inventory resource. |
| `PUT` | `/api/inventory/resources/{resourceId}` | `core.configure` | CAS update mutable resource state. |
| `POST` | `/api/inventory/resources/{resourceId}/retire` | `core.configure` | Transition resource to terminal retired state. |

Frontend SPA assets are built from `frontend/` and embedded directly into the Go binary at `backend/internal/spa/static`.

### 4.2 Keyset Cursor Pagination & Query Parameter Allowlist
`GET /api/inventory/resources` supports deterministic keyset pagination and strictly validated queries:
- Default sort order: `{ updatedAt: -1, _id: 1 }`.
- Allowed query parameters: `kind`, `domain`, `lifecycleState`, `q`, `limit`, `cursor`.
- Any unsupported query parameter returns HTTP 400 (`UNSUPPORTED_QUERY_PARAMETER`).
- `limit`: Integer bounded between 1 and 200 (default 50). Out of bounds returns HTTP 400 (`INVALID_LIMIT`).
- `cursor`: Opaque base64 cursor token containing `{ u: updatedAt, i: id }`. Malformed tokens return HTTP 400 (`INVALID_CURSOR`).
- `q`: Search by exact UUID or case-insensitive prefix on `nameNormalized`.
- Response format:
  ```json
  {
    "resources": [...],
    "page": {
      "limit": 50,
      "nextCursor": "...",
      "hasMore": true
    }
  }
  ```

### 4.3 Audit Logging
All inventory mutations record audit events to `xcloud_ops.app_audit_logs` via the asynchronous audit writer:
- `inventory.resource.create`
- `inventory.resource.update`
- `inventory.resource.retire`

---

## 5. Architectural Examples

### 5.1 Site Resource
```json
{
  "resourceId": "7b8f9a01-2c3d-4e5f-8a1b-9c0d1e2f3a4b",
  "schemaVersion": 1,
  "kind": "site",
  "name": "edge-dc-frankfurt-01",
  "displayName": "Frankfurt Central Edge Datacenter",
  "description": "Primary regional edge computing facility",
  "domain": "cloud",
  "role": "edge-datacenter",
  "lifecycleState": "active",
  "vendor": "Equinix",
  "model": "IBX-FR2",
  "labels": {
    "region": "eu-central",
    "country": "de",
    "tier": "tier-3"
  },
  "attributes": {
    "rackCapacity": 48,
    "powerCapacityKw": 250,
    "coordinates": {
      "latitude": 50.1109,
      "longitude": 8.6821
    }
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T08:00:00Z",
  "createdBy": "admin",
  "updatedAt": "2026-10-05T08:00:00Z",
  "updatedBy": "admin"
}
```

### 5.2 Host Resource
```json
{
  "resourceId": "8c9a0b12-3d4e-5f6a-9b2c-0d1e2f3a4b5c",
  "schemaVersion": 1,
  "kind": "host",
  "name": "compute-node-042",
  "displayName": "Compute Node 42",
  "domain": "platform",
  "role": "hypervisor",
  "lifecycleState": "active",
  "vendor": "Dell",
  "model": "PowerEdge R750",
  "software": {
    "product": "Ubuntu Linux",
    "version": "24.04-LTS",
    "build": "kernel-6.8.0-generic"
  },
  "managementEndpoints": [
    {
      "name": "idrac",
      "protocol": "https",
      "addressType": "ipv4",
      "address": "10.120.4.42",
      "port": 443
    },
    {
      "name": "ssh-admin",
      "protocol": "ssh",
      "addressType": "ipv4",
      "address": "10.120.4.42",
      "port": 22
    }
  ],
  "capabilities": ["kvm", "numa", "sr-iov"],
  "labels": {
    "site": "edge-dc-frankfurt-01",
    "rack": "rack-b-12"
  },
  "attributes": {
    "cpuCores": 128,
    "memoryGib": 512,
    "storageTib": 7.68
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T08:15:00Z",
  "createdBy": "admin",
  "updatedAt": "2026-10-05T08:15:00Z",
  "updatedBy": "admin"
}
```

### 5.3 5GC Network Function Instance (AMF)
```json
{
  "resourceId": "9d0b1c23-4e5f-6a7b-0c3d-1e2f3a4b5c6d",
  "schemaVersion": 1,
  "kind": "network_function_instance",
  "name": "amf-core-eu-01",
  "displayName": "Access and Mobility Management Function Instance 01",
  "domain": "5gc",
  "role": "amf",
  "lifecycleState": "active",
  "vendor": "Open5GS",
  "software": {
    "product": "Open5GS 5G Core",
    "version": "2.7.2",
    "build": "git-b49d7"
  },
  "managementEndpoints": [
    {
      "name": "sbi-namf",
      "protocol": "sbi",
      "addressType": "fqdn",
      "address": "amf-01.internal.core.local",
      "port": 7777,
      "path": "/namf-comm/v1"
    },
    {
      "name": "ngap-n2",
      "protocol": "ngap",
      "addressType": "ipv4",
      "address": "10.200.1.10",
      "port": 38412
    }
  ],
  "capabilities": ["5g-nas", "n2-handover", "security-anchor"],
  "labels": {
    "cluster": "k8s-core-fra-01",
    "slice": "sst-1-default"
  },
  "attributes": {
    "guamiList": [
      { "plmnId": "00101", "amfRegionId": "01", "amfSetId": "001", "amfPointer": "01" }
    ],
    "taiList": [
      { "plmnId": "00101", "tac": "000001" }
    ]
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T08:30:00Z",
  "createdBy": "operator",
  "updatedAt": "2026-10-05T08:30:00Z",
  "updatedBy": "operator"
}
```

### 5.4 IMS Network Function Instance (P-CSCF)
```json
{
  "resourceId": "a11c2d34-5f6a-7b8c-1d4e-2f3a4b5c6d7e",
  "schemaVersion": 1,
  "kind": "network_function_instance",
  "name": "pcscf-ims-fra-01",
  "displayName": "Proxy-Call Session Control Function 01",
  "domain": "ims",
  "role": "pcscf",
  "lifecycleState": "active",
  "vendor": "Kamailio",
  "software": {
    "product": "Kamailio IMS Suite",
    "version": "5.8.1",
    "build": "release-ims"
  },
  "managementEndpoints": [
    {
      "name": "sip-gm",
      "protocol": "sip",
      "addressType": "ipv4",
      "address": "10.210.1.50",
      "port": 5060
    },
    {
      "name": "diameter-rx",
      "protocol": "diameter",
      "addressType": "fqdn",
      "address": "rx.pcrf.ims.local",
      "port": 3868
    }
  ],
  "capabilities": ["sip-nat-traversal", "ipsec-gm", "qos-reservation"],
  "labels": {
    "environment": "production",
    "apn": "ims"
  },
  "attributes": {
    "sipDomain": "ims.mnc001.mcc001.3gppnetwork.org",
    "maxRegistrations": 500000
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T08:45:00Z",
  "createdBy": "operator",
  "updatedAt": "2026-10-05T08:45:00Z",
  "updatedBy": "operator"
}
```

### 5.5 Interface / IP Resource
```json
{
  "resourceId": "b22d3e45-6a7b-8c9d-2e5f-3a4b5c6d7e8f",
  "schemaVersion": 1,
  "kind": "ip_address",
  "name": "n3-upf-ingress-ip",
  "displayName": "UPF N3 Ingress Gateway IP",
  "domain": "5gc",
  "role": "gtp-u-endpoint",
  "lifecycleState": "active",
  "managementEndpoints": [
    {
      "name": "gtpu-n3",
      "protocol": "gtp",
      "addressType": "ipv4",
      "address": "10.250.3.1",
      "port": 2152
    }
  ],
  "capabilities": ["gtp-u", "user-plane"],
  "labels": {
    "interfaceName": "eth1.250",
    "networkZone": "n3-ran-upf"
  },
  "attributes": {
    "subnetMask": "255.255.255.0",
    "gateway": "10.250.3.254",
    "vlanId": 250
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T09:00:00Z",
  "createdBy": "operator",
  "updatedAt": "2026-10-05T09:00:00Z",
  "updatedBy": "operator"
}
```

### 5.6 PLMN Resource
```json
{
  "resourceId": "c33e4f56-7b8c-9d0e-3f6a-4b5c6d7e8f9a",
  "schemaVersion": 1,
  "kind": "plmn",
  "name": "plmn-001-01",
  "displayName": "Public Land Mobile Network 001-01",
  "domain": "shared",
  "role": "home-network",
  "lifecycleState": "active",
  "labels": {
    "mcc": "001",
    "mnc": "01",
    "scope": "national"
  },
  "attributes": {
    "mcc": "001",
    "mnc": "01",
    "brandName": "xCloud Mobile",
    "countryCode": "001"
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T09:10:00Z",
  "createdBy": "admin",
  "updatedAt": "2026-10-05T09:10:00Z",
  "updatedBy": "admin"
}
```

### 5.7 Data Network Name (DNN) Resource
```json
{
  "resourceId": "d44f5a67-8c9d-0e1f-4a7b-5c6d7e8f9a0b",
  "schemaVersion": 1,
  "kind": "dnn",
  "name": "dnn-internet",
  "displayName": "Standard Internet Access Data Network",
  "domain": "5gc",
  "role": "public-apn",
  "lifecycleState": "active",
  "labels": {
    "accessType": "public",
    "dnsAssigned": "primary"
  },
  "attributes": {
    "dnnString": "internet",
    "ipPoolSubnet": "10.45.0.0/16",
    "defaultQosClass": 9
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T09:20:00Z",
  "createdBy": "operator",
  "updatedAt": "2026-10-05T09:20:00Z",
  "updatedBy": "operator"
}
```

### 5.8 Network Slice Resource
```json
{
  "resourceId": "e55a6b78-9d0e-1f2a-5b8c-6d7e8f9a0b1c",
  "schemaVersion": 1,
  "kind": "network_slice",
  "name": "slice-embb-gold",
  "displayName": "Enhanced Mobile Broadband Gold Tier Slice",
  "domain": "5gc",
  "role": "embb-slice",
  "lifecycleState": "active",
  "labels": {
    "sst": "1",
    "serviceClass": "premium"
  },
  "attributes": {
    "sst": 1,
    "sd": "000001",
    "maxBitrateDownlinkMbps": 1000,
    "maxBitrateUplinkMbps": 200,
    "associatedDnns": ["internet", "ims"]
  },
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "2026-10-05T09:30:00Z",
  "createdBy": "operator",
  "updatedAt": "2026-10-05T09:30:00Z",
  "updatedBy": "operator"
}
```

---

## 6. Current Limitations and Evolution Roadmap

### 6.1 Current Scope (Stage 1)
- Authoritative resource inventory metadata records with full audit trail.
- Keyset cursor pagination and single-attribute lookups.
- Strict CAS revision guards preventing lost updates.
- Hard terminal retirement preventing accidental modification of decommissioned equipment.

### 6.2 Future Evolution (Out of Scope for Stage 1)
- **Topology Relationships**: Directed graph edges (`app_inventory_relations`) connecting sites to racks, hosts to VMs, or NFs to slices will be delivered in Stage 2.
- **Discovery Adapters**: Ingest engines pulling metadata automatically from Kubernetes, OpenStack, VMware, or network element SBI endpoints.
- **Remote Network Execution**: Command dispatching, SSH execution, NETCONF configuration pushes, and active network telemetry polling.
- **Direct Subscriber Interop**: Subscriber identities remain safely segregated in the Core/OCS database (`xcloud`) and are not merged into resource inventory.
