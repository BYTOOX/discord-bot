/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  com.sedmelluq.discord.lavaplayer.tools.DataFormatTools
 *  com.sedmelluq.discord.lavaplayer.tools.JsonBrowser
 *  com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface
 *  com.sedmelluq.discord.lavaplayer.track.AudioTrack
 *  org.jetbrains.annotations.NotNull
 */
package dev.lavalink.youtube.clients;

import com.sedmelluq.discord.lavaplayer.tools.DataFormatTools;
import com.sedmelluq.discord.lavaplayer.tools.JsonBrowser;
import com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface;
import com.sedmelluq.discord.lavaplayer.track.AudioTrack;
import dev.lavalink.youtube.YoutubeAudioSourceManager;
import dev.lavalink.youtube.clients.ClientConfig;
import dev.lavalink.youtube.clients.ClientOptions;
import dev.lavalink.youtube.clients.skeleton.StreamingNonMusicClient;
import java.util.List;
import java.util.Map;
import org.jetbrains.annotations.NotNull;

public class TvHtml5Simply
extends StreamingNonMusicClient {
    public static ClientConfig BASE_CONFIG = new ClientConfig().withClientName("TVHTML5_SIMPLY").withClientField("clientVersion", "1.0").withRootField("attestationRequest", Map.of("omitBotguardData", true));
    protected ClientOptions options;

    public TvHtml5Simply() {
        this(ClientOptions.DEFAULT);
    }

    public TvHtml5Simply(@NotNull ClientOptions options) {
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
        return super.canHandleRequest(identifier);
    }

    @Override
    @NotNull
    public String getIdentifier() {
        return BASE_CONFIG.getName();
    }

    @Override
    public boolean isEmbedded() {
        return true;
    }

    @Override
    @NotNull
    protected JsonBrowser extractPlaylistVideoList(@NotNull JsonBrowser json) {
        return json.get("contents").get("sectionListRenderer").get("contents").index(0).get("playlistVideoListRenderer");
    }

    @Override
    protected String extractPlaylistName(@NotNull JsonBrowser json) {
        return json.get("header").get("playlistHeaderRenderer").get("title").get("runs").index(0).get("text").text();
    }

    @Override
    protected void extractPlaylistTracks(@NotNull JsonBrowser json, @NotNull List<AudioTrack> tracks, @NotNull YoutubeAudioSourceManager source) {
        if (!json.get("contents").isNull()) {
            json = json.get("contents");
        }
        if (json.isNull()) {
            return;
        }
        for (JsonBrowser track : json.values()) {
            String lengthText;
            String videoId;
            JsonBrowser item = track.get("videoRenderer");
            if (item.isNull()) continue;
            JsonBrowser authorJson = item.get("shortBylineText");
            if (authorJson.isNull()) {
                authorJson = item.get("longBylineText");
            }
            if (authorJson.isNull() || (videoId = item.get("videoId").text()) == null) continue;
            JsonBrowser titleField = item.get("title");
            String title = (String)DataFormatTools.defaultOnNull((Object)titleField.get("simpleText").text(), (Object)titleField.get("runs").index(0).get("text").text());
            String author = (String)DataFormatTools.defaultOnNull((Object)authorJson.get("runs").index(0).get("text").text(), (Object)"Unknown artist");
            long duration = Long.MAX_VALUE;
            JsonBrowser lengthJson = item.get("lengthText");
            if (!lengthJson.isNull() && (lengthText = (String)DataFormatTools.defaultOnNull((Object)lengthJson.get("runs").index(0).get("text").text(), (Object)lengthJson.get("simpleText").text())) != null) {
                duration = DataFormatTools.durationTextToMillis((String)lengthText);
            }
            tracks.add(this.buildAudioTrack(source, item, title, author, duration, videoId, false));
        }
    }
}
