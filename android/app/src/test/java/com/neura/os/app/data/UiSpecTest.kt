package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Generative UI: a reply's ```ui block becomes native choices, a form, a
// table or a card -- or, if it is not exactly one of those within limits,
// stays on screen as code. Nothing in it runs.
class UiSpecTest {

    @Test fun `choices parse, and duplicates collapse`() {
        val spec = parseUiSpec("""{"type":"choices","prompt":"Which city?","options":["Paris","Rome","Paris"]}""") as UiSpec.Choices
        assertEquals("Which city?", spec.prompt)
        assertEquals(listOf("Paris", "Rome"), spec.options)
    }

    @Test fun `a form parses its fields and kinds`() {
        val spec = parseUiSpec(
            """{"type":"form","title":"Book","fields":[{"id":"when","label":"Date","kind":"date","required":true},""" +
                """{"id":"n","label":"Guests","kind":"number"},{"id":"room","label":"Room","kind":"select","options":["Single","Double"]}],"submit":"Book it"}""",
        ) as UiSpec.Form
        assertEquals(listOf(FieldKind.DATE, FieldKind.NUMBER, FieldKind.SELECT), spec.fields.map { it.kind })
        assertEquals("Book it", spec.submit)
        assertTrue(spec.fields.first().required)
    }

    @Test fun `a table pads short rows and refuses wide ones`() {
        val spec = parseUiSpec("""{"type":"table","columns":["A","B"],"rows":[["1","2"],["3"]]}""") as UiSpec.Table
        assertEquals(listOf(listOf("1", "2"), listOf("3", "")), spec.rows)
        assertNull(parseUiSpec("""{"type":"table","columns":["A"],"rows":[["1","2"]]}"""))
    }

    @Test fun `anything off-shape stays code`() {
        assertNull(parseUiSpec("""{"type":"script","code":"alert(1)"}"""))
        assertNull(parseUiSpec("""{"type":"choices","options":[]}"""))
        assertNull(parseUiSpec("""{"type":"choices","options":[{"nested":true}]}"""))
        assertNull(parseUiSpec("""{"type":"form","fields":[{"id":"bad id","kind":"text"}]}"""))
        assertNull(parseUiSpec("""{"type":"form","fields":[{"id":"a","kind":"html"}]}"""))
        assertNull(parseUiSpec("""{"type":"form","fields":[{"id":"a","kind":"select"}]}"""))
        assertNull(parseUiSpec("""{"type":"form","fields":[{"id":"a"},{"id":"a"}]}"""))
        assertNull(parseUiSpec("""{"type":"card"}"""))
        assertNull(parseUiSpec("""{"type":"choices","options":["a"""))
        val nine = (1..9).joinToString(",") { "\"o$it\"" }
        assertNull(parseUiSpec("""{"type":"choices","options":[$nine]}"""))
    }

    @Test fun `a form answer is one line per filled field, checked first`() {
        val form = parseUiSpec(
            """{"type":"form","fields":[{"id":"name","label":"Name","required":true},{"id":"age","label":"Age","kind":"number"},{"id":"note","label":"Note"}]}""",
        ) as UiSpec.Form
        assertEquals("Fill in: Name", formAnswer(form, mapOf("age" to "3")).exceptionOrNull()?.message)
        assertEquals("Age needs a number", formAnswer(form, mapOf("name" to "Sam", "age" to "three")).exceptionOrNull()?.message)
        assertEquals("Name: Sam\nAge: 3", formAnswer(form, mapOf("name" to " Sam ", "age" to "3", "note" to " ")).getOrNull())
    }

    @Test fun `pickers write the same text a person would type`() {
        val millis = dateMillisOf("2026-09-23")!!
        assertEquals("2026-09-23", pickedDate(millis))
        assertNull(dateMillisOf("next tuesday"))
        assertEquals("09:05", pickedTime(9, 5))
        assertEquals("23:59", pickedTime(24, 75))
    }
}
