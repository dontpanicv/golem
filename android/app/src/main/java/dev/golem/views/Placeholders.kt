package dev.golem.views

import androidx.compose.runtime.Composable

@Composable fun SearchView() {}
@Composable fun InboxView() {}
@Composable fun AgendaView(page: AgendaPage, setPage: (AgendaPage) -> Unit) {}
@Composable fun FeedbackView() {}
@Composable fun Suggestions(running: Boolean?) {}
