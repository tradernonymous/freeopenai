package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

// A real bug (master plan v2 review batch): AppViewModel.delete() and
// newChat() removed entries from `conversations` and only patched the one
// id involved in conversationIndex, leaving every chat after the removed
// slot pointing at the wrong position -- crashing or overwriting the wrong
// conversation on its next save. rebuildConversationIndex() is the fix:
// every mutation that changes list order or length must rebuild in full.
class ConversationIndexTest {
    private fun chat(id: String) = Conversation(id, "T", "assistant", "p", "m", emptyList(), 0, 0)

    @Test
    fun emptyList_indexesNothing() {
        assertEquals(emptyMap<String, Int>(), rebuildConversationIndex(emptyList()))
    }

    @Test
    fun ordersMatchListPosition() {
        val index = rebuildConversationIndex(listOf(chat("a"), chat("b"), chat("c")))
        assertEquals(mapOf("a" to 0, "b" to 1, "c" to 2), index)
    }

    @Test
    fun removingFromTheMiddle_shiftsEveryLaterEntry() {
        // Simulates delete("b") on [a, b, c]: the naive fix of just calling
        // conversationIndex.remove("b") on the old index would leave "c" at
        // position 2, one past the end of the two-item list that remains.
        val after = listOf(chat("a"), chat("c"))
        val index = rebuildConversationIndex(after)
        assertEquals(0, index.getValue("a"))
        assertEquals(1, index.getValue("c"))
        assertEquals(null, index["b"])
    }

    @Test
    fun replacingAnEmptyChatWithANewOne_reindexesWhatSurvives() {
        // newChat() drops every other empty, unstreamed chat before adding
        // the fresh one -- the same shift-after-removal hazard as delete().
        val survivors = listOf(chat("kept-1"), chat("kept-2"))
        val index = rebuildConversationIndex(survivors)
        assertEquals(0, index.getValue("kept-1"))
        assertEquals(1, index.getValue("kept-2"))
    }
}
