package dev.golem.views

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.golem.design.PillBar
import dev.golem.design.Tokens

/**
 * Following and Upcoming on one tab: what Golem follows from the accounts it reads, and what it runs and what waits
 * for the person. Pills switch between them, as Linear's do; Following comes first. Each page puts the title and the
 * pills at its top, so its details can cover them.
 */
@Composable
fun AgendaView(page: AgendaPage, setPage: (AgendaPage) -> Unit) {
    val header: @Composable () -> Unit = {
        Column {
            ScreenBar("Agenda")
            Box(Modifier.padding(vertical = Tokens.Space.md)) { PillBar(page, AgendaPage.entries, { it.name }, setPage) }
        }
    }
    // A page's detail covers it in this box.
    Box(Modifier.fillMaxSize()) {
        when (page) {
            AgendaPage.Following -> FollowingList(header)
            AgendaPage.Upcoming -> UpcomingList(header)
        }
    }
}
