export type DocxFormatJson = null | boolean | number | string | DocxFormatJson[] | { [key: string]: DocxFormatJson };
export type DocxFormatProperties = { [key: string]: DocxFormatJson };
export type DocxFormatRole =
  | "document_title" | "author" | "affiliation" | "abstract_heading" | "abstract"
  | "keywords" | "heading" | "body" | "caption" | "reference" | "table"
  | "header" | "footer" | "footnote" | "endnote" | "unknown";
export type DocxFormatRegionRole =
  | "front_matter" | "body" | "references" | "appendix" | "mixed" | "unknown";

export interface DocxFormatRoleBasis {
  source: "style_id" | "style_name" | "outline_level" | "content" | "story" | "context";
  value: string;
  certainty: "explicit" | "inferred" | "uncertain";
}

export interface DocxFormatRegion {
  section_object_id: string;
  role: DocxFormatRegionRole;
  role_basis: DocxFormatRoleBasis[];
}

export interface DocxFormatObject {
  object_id: string;
  part: string;
  path: number[];
  kind: string;
  role: DocxFormatRole;
  role_basis: DocxFormatRoleBasis[];
  region?: DocxFormatRegion;
  text?: string;
  style_id?: string;
  properties: DocxFormatProperties;
  declared: DocxFormatProperties;
  evidence: DocxFormatProperties;
}

export interface DocxFormatSnapshotV1 {
  schema_version: 1;
  source_sha256: string;
  engine: { name: "@docx-editor.dev/core"; version: string };
  parts: {
    name: string;
    content_type: string | null;
    byte_length: number;
    sha256: string;
    xml: boolean;
    status: "parsed" | "binary" | "unparsed";
    node_count: number;
  }[];
  objects: DocxFormatObject[];
  capabilities: {
    package_entries: "all";
    raw_part_bytes: true;
    xml_tree_query: true;
    relationship_query: true;
    effective_paragraphs: true;
    effective_runs: true;
    effective_sections: true;
    effective_tables: "semantic_structure";
    role_assignment: "evidence_with_uncertainty";
    rendered_pagination: false;
    journal_compliance: false;
    path_addressing: "canonical_tree_child_indices";
  };
  unsupported: { code: string; detail: string; object_ids: string[] }[];
}

export type DocxFormatQueryRequest =
  | { kind: "part"; part: string; format: "bytes" | "text" | "tree" }
  | {
      kind: "nodes";
      part?: string;
      path?: number[];
      namespace_uri?: string;
      local_name?: string;
      attribute?: { namespace_uri?: string; local_name: string; value?: string };
      offset?: number;
      limit?: number;
    }
  | { kind: "relationships"; part?: string };

export type DocxFormatQueryResult = {
  schema_version: 1;
  source_sha256: string;
} & (
  | { kind: "part"; part: string; format: "bytes"; data: Uint8Array }
  | { kind: "part"; part: string; format: "text"; data: string }
  | { kind: "part"; part: string; format: "tree"; data: DocxFormatJson }
  | { kind: "nodes"; nodes: { part: string; path: number[]; node: DocxFormatProperties }[]; total: number; next_offset: number | null }
  | { kind: "relationships"; relationships: DocxFormatProperties[] }
);

export interface DocxFormatFacts {
  snapshot: DocxFormatSnapshotV1;
  query(request: DocxFormatQueryRequest): DocxFormatQueryResult;
}
