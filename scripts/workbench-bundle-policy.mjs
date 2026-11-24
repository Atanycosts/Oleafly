const LOCAL_POLICY = "local";
const PUBLIC_UNBUNDLED_POLICY = "public-unbundled";
const SUPPORTED_POLICIES = new Set([LOCAL_POLICY, PUBLIC_UNBUNDLED_POLICY]);

export function resolveWorkbenchBundlePolicy(value) {
  const policy = value?.trim() || LOCAL_POLICY;
  if (!SUPPORTED_POLICIES.has(policy)) {
    throw new Error(
      `unsupported OLEAFLY_WORKBENCH_BUNDLE_POLICY: ${policy}. ` +
        "Only local and public-unbundled are implemented; public binary bundling needs " +
        "a verified PyMuPDF corresponding-source or commercial release policy.",
    );
  }
  return policy;
}

export function workbenchBundleDecision({
  policy,
  target,
  hostTarget,
  debug,
  supportedTargets,
}) {
  const resolvedPolicy = resolveWorkbenchBundlePolicy(policy);
  if (resolvedPolicy === PUBLIC_UNBUNDLED_POLICY) {
    return { kind: "unavailable", policy: resolvedPolicy, reason: "public-release" };
  }
  if (debug) return { kind: "development", policy: resolvedPolicy };
  if (!supportedTargets.has(target) || target !== hostTarget) {
    return { kind: "unavailable", policy: resolvedPolicy, reason: "unsupported-target" };
  }
  return { kind: "build", policy: resolvedPolicy };
}
