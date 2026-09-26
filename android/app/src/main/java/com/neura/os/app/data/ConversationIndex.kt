package com.neura.os.app.data

/** id -> position in a conversation list. Any change that adds, removes or
 * reorders entries must rebuild the whole map from this rather than patch
 * only the id(s) directly touched: a patch leaves every entry after the
 * changed position stale, and a later write through a stale index either
 * overwrites the wrong conversation or runs past the end of the (now
 * shorter) list. */
fun rebuildConversationIndex(conversations: List<Conversation>): Map<String, Int> =
    buildMap { conversations.forEachIndexed { i, c -> put(c.id, i) } }
