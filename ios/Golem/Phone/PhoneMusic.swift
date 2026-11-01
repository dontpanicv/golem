import MusicKit

/// Apple Music in the Music app (MusicKit): it finds music in the catalog and plays it with the system player, so it
/// plays on after Golem closes.
enum PhoneMusic {
    private struct PlayArguments: Decodable {
        let query: String
        let kind: String?
    }

    private struct ControlArguments: Decodable {
        let action: String
    }

    private struct Status: Encodable {
        let playing: Bool
        let title: String?
        let artist: String?
    }

    static func play(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(PlayArguments.self)
        try await authorize()
        let player = SystemMusicPlayer.shared
        let found: String
        do {
            switch arguments.kind ?? "song" {
            case "album":
                let album = try await first(arguments.query, Album.self)
                player.queue = SystemMusicPlayer.Queue(for: [album])
                found = "\(album.title) by \(album.artistName)"
            case "playlist":
                let playlist = try await first(arguments.query, Playlist.self)
                player.queue = SystemMusicPlayer.Queue(for: [playlist])
                found = playlist.name
            case "artist":
                let artist = try await first(arguments.query, Artist.self).with([.topSongs])
                guard let songs = artist.topSongs, !songs.isEmpty else { throw PhoneError("\(artist.name) has no top songs.") }
                player.queue = SystemMusicPlayer.Queue(for: songs)
                found = "the top songs of \(artist.name)"
            default:
                let song = try await first(arguments.query, Song.self)
                player.queue = SystemMusicPlayer.Queue(for: [song])
                found = "\(song.title) by \(song.artistName)"
            }
            try await player.play()
        } catch let error as PhoneError {
            throw error
        } catch {
            throw PhoneError("Apple Music failed: \(error.localizedDescription). It needs an Apple Music subscription.")
        }
        return PhoneAnswer(text: "Playing \(found).")
    }

    static func control(_ call: PhoneCall) async throws -> PhoneAnswer {
        let action = try call.arguments(ControlArguments.self).action
        try await authorize()
        let player = SystemMusicPlayer.shared
        switch action {
        case "play": try await player.play()
        case "pause": player.pause()
        case "next": try await player.skipToNextEntry()
        case "previous": try await player.skipToPreviousEntry()
        case "status": break
        default: throw PhoneError("action must be play, pause, next, previous, or status.")
        }
        let entry = player.queue.currentEntry
        return try .json(Status(
            playing: player.state.playbackStatus == .playing, title: entry?.title, artist: entry?.subtitle
        ))
    }

    private static func first<Item: MusicCatalogSearchable>(_ query: String, _ type: Item.Type) async throws -> Item {
        var request = MusicCatalogSearchRequest(term: query, types: [type])
        request.limit = 1
        let response = try await request.response()
        let items: [any MusicCatalogSearchable] = switch type {
        case is Song.Type: Array(response.songs)
        case is Album.Type: Array(response.albums)
        case is Playlist.Type: Array(response.playlists)
        default: Array(response.artists)
        }
        guard let item = items.first as? Item else { throw PhoneError("Apple Music has nothing for \(query).") }
        return item
    }

    private static func authorize() async throws {
        if MusicAuthorization.currentStatus == .authorized { return }
        guard await MusicAuthorization.request() == .authorized else {
            throw PhoneError("The person did not allow Golem to use Apple Music: Settings › Apps › Golem › Media & Apple Music.")
        }
    }
}
