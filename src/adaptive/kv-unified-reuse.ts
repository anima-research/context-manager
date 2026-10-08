import type { CanonicalSummaryForest } from './kv-unified.js';
import type { SummaryTree } from './summary-tree.js';
import type { CertificateDag } from './kv-unified-certificate.js';

/**
 * Mutable holder a host keeps across compiles so structures that depend only
 * on unchanged ownership can be derived instead of rebuilt. Every entry is
 * validated against the new inputs before use; a stale holder costs a miss.
 * What-if solves never read or write it.
 */
export interface KvUnifiedReuse {
  forest?: CanonicalSummaryForest;
  tree?: SummaryTree;
  certificate?: CertificateDag;
}
