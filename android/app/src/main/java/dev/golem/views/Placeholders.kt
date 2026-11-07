package dev.golem.views

import androidx.compose.runtime.Composable

@Composable fun AgendaView(page: AgendaPage, setPage: (AgendaPage) -> Unit) {}
@Composable fun SettingsView() {}
@Composable fun WorkspaceSettingsView() {}
@Composable fun ChannelDetailsView(id: String) {}
@Composable fun FeedbackView() {}
@Composable fun Suggestions(running: Boolean?) {}
