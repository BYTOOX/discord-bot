/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  com.sedmelluq.discord.lavaplayer.tools.FriendlyException
 *  com.sedmelluq.discord.lavaplayer.tools.FriendlyException$Severity
 *  com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface
 *  com.sedmelluq.discord.lavaplayer.track.AudioItem
 *  org.jetbrains.annotations.NotNull
 *  org.jetbrains.annotations.Nullable
 */
package dev.lavalink.youtube.clients;

import com.sedmelluq.discord.lavaplayer.tools.FriendlyException;
import com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface;
import com.sedmelluq.discord.lavaplayer.track.AudioItem;
import dev.lavalink.youtube.CannotBeLoaded;
import dev.lavalink.youtube.YoutubeAudioSourceManager;
import dev.lavalink.youtube.clients.ClientConfig;
import dev.lavalink.youtube.clients.ClientOptions;
import dev.lavalink.youtube.clients.skeleton.StreamingNonMusicClient;
import java.io.IOException;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class Tv
extends StreamingNonMusicClient {
    public static ClientConfig BASE_CONFIG = new ClientConfig().withClientName("TVHTML5").withUserAgent("Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version").withClientField("clientVersion", "7.20250319.10.00");
    protected ClientOptions options;

    public Tv() {
        this(ClientOptions.DEFAULT);
    }

    public Tv(@NotNull ClientOptions options) {
        this.options = options;
    }

    @Override
    @NotNull
    protected ClientConfig getBaseClientConfig(@NotNull HttpInterface httpInterface) {
        return BASE_CONFIG.copy();
    }

    @Override
    @NotNull
    public String getPlayerParams() {
        return WEB_PLAYER_PARAMS;
    }

    @Override
    @NotNull
    public ClientOptions getOptions() {
        return this.options;
    }

    @Override
    public boolean canHandleRequest(@NotNull String identifier) {
        return false;
    }

    @Override
    public boolean supportsOAuth() {
        return true;
    }

    @Override
    @NotNull
    public String getIdentifier() {
        return BASE_CONFIG.getName();
    }

    @Override
    public AudioItem loadPlaylist(@NotNull YoutubeAudioSourceManager source, @NotNull HttpInterface httpInterface, @NotNull String playlistId, @Nullable String selectedVideoId) {
        throw new FriendlyException("This client cannot load playlists", FriendlyException.Severity.COMMON, (Throwable)new RuntimeException("TVHTML5 cannot be used to load playlists"));
    }

    @Override
    public AudioItem loadVideo(@NotNull YoutubeAudioSourceManager source, @NotNull HttpInterface httpInterface, @NotNull String videoId) throws CannotBeLoaded, IOException {
        throw new FriendlyException("This client cannot load videos", FriendlyException.Severity.COMMON, (Throwable)new RuntimeException("TVHTML5 cannot be used to load videos"));
    }

    @Override
    public AudioItem loadMix(@NotNull YoutubeAudioSourceManager source, @NotNull HttpInterface httpInterface, @NotNull String mixId, @Nullable String selectedVideoId) {
        throw new FriendlyException("This client cannot load mixes", FriendlyException.Severity.COMMON, (Throwable)new RuntimeException("TVHTML5 cannot be used to load mixes"));
    }

    @Override
    public AudioItem loadSearch(@NotNull YoutubeAudioSourceManager source, @NotNull HttpInterface httpInterface, @NotNull String searchQuery) {
        throw new FriendlyException("This client cannot search", FriendlyException.Severity.COMMON, (Throwable)new RuntimeException("TVHTML5 cannot be used to search"));
    }
}
