package com.freeai4u.app.data

// Compare asks the same prompt of two providers and shows both replies. It is
// deliberately two, sequential, and tool-free: fanning out further, or running
// them at once, would need the app's single in-flight HTTP connection and
// streamingId (AppViewModel) to track more than one reply at a time, which is
// exactly the reliability guarantee the rest of the app leans on.

/** One side of a Compare run -- a fixed provider+model pair. */
data class CompareTarget(val provider: String, val model: String)

/** Comparing a target against itself would just show one reply twice. */
fun compareTargetsValid(a: CompareTarget, b: CompareTarget): Boolean = a != b

/** Picks a second target to compare [first] against: a different provider's
 * first model when one is configured (a cross-provider comparison is usually
 * the more interesting one), otherwise a different model on the same
 * provider. Null when neither exists, so the caller can say there is nothing
 * to compare against instead of silently comparing a target with itself. */
fun defaultCompareTarget(
    first: CompareTarget,
    providers: List<ProviderInfo>,
    modelsByProvider: Map<String, List<ModelInfo>>,
): CompareTarget? {
    val otherProvider = providers.firstOrNull { it.id != first.provider }
    val fromOtherProvider = otherProvider?.let { provider -> modelsByProvider[provider.id]?.firstOrNull()?.let { CompareTarget(provider.id, it.id) } }
    if (fromOtherProvider != null) return fromOtherProvider
    val otherModel = modelsByProvider[first.provider].orEmpty().firstOrNull { it.id != first.model }
    return otherModel?.let { CompareTarget(first.provider, it.id) }
}
