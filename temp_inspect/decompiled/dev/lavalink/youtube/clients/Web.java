/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  com.sedmelluq.discord.lavaplayer.tools.DataFormatTools
 *  com.sedmelluq.discord.lavaplayer.tools.ExceptionTools
 *  com.sedmelluq.discord.lavaplayer.tools.JsonBrowser
 *  com.sedmelluq.discord.lavaplayer.tools.io.HttpClientTools
 *  com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface
 *  com.sedmelluq.discord.lavaplayer.track.AudioTrack
 *  org.apache.http.HttpEntity
 *  org.apache.http.HttpResponse
 *  org.apache.http.client.methods.CloseableHttpResponse
 *  org.apache.http.client.methods.HttpGet
 *  org.apache.http.client.methods.HttpUriRequest
 *  org.apache.http.client.utils.URIBuilder
 *  org.apache.http.util.EntityUtils
 *  org.jetbrains.annotations.NotNull
 *  org.jetbrains.annotations.Nullable
 *  org.slf4j.Logger
 *  org.slf4j.LoggerFactory
 */
package dev.lavalink.youtube.clients;

import com.sedmelluq.discord.lavaplayer.tools.DataFormatTools;
import com.sedmelluq.discord.lavaplayer.tools.ExceptionTools;
import com.sedmelluq.discord.lavaplayer.tools.JsonBrowser;
import com.sedmelluq.discord.lavaplayer.tools.io.HttpClientTools;
import com.sedmelluq.discord.lavaplayer.tools.io.HttpInterface;
import com.sedmelluq.discord.lavaplayer.track.AudioTrack;
import dev.lavalink.youtube.YoutubeAudioSourceManager;
import dev.lavalink.youtube.clients.ClientConfig;
import dev.lavalink.youtube.clients.ClientOptions;
import dev.lavalink.youtube.clients.skeleton.StreamingNonMusicClient;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.apache.http.HttpEntity;
import org.apache.http.HttpResponse;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpUriRequest;
import org.apache.http.client.utils.URIBuilder;
import org.apache.http.util.EntityUtils;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Web
extends StreamingNonMusicClient {
    private static final Logger log = LoggerFactory.getLogger(Web.class);
    protected static Pattern CONFIG_REGEX = Pattern.compile("ytcfg\\.set\\((\\{.+})\\);");
    public static ClientConfig BASE_CONFIG = new ClientConfig().withClientName("WEB").withClientField("clientVersion", "2.20250403.01.00").withUserField("lockedSafetyMode", false);
    public static String poToken;
    protected volatile long lastConfigUpdate = -1L;
    protected ClientOptions options;

    public Web() {
        this(ClientOptions.DEFAULT);
    }

    public Web(@NotNull ClientOptions options) {
        this.options = options;
    }

    public static void setPoTokenAndVisitorData(String poToken, String visitorData) {
        Web.poToken = poToken;
        if (poToken == null || visitorData == null) {
            BASE_CONFIG.getRoot().remove("serviceIntegrityDimensions");
            BASE_CONFIG.withVisitorData(null);
            return;
        }
        Map<String, Object> sid = BASE_CONFIG.putOnceAndJoin(BASE_CONFIG.getRoot(), "serviceIntegrityDimensions");
        sid.put("poToken", poToken);
        BASE_CONFIG.withVisitorData(visitorData);
    }

    protected void fetchClientConfig(@NotNull HttpInterface httpInterface) {
        try (CloseableHttpResponse response = httpInterface.execute((HttpUriRequest)new HttpGet("https://www.youtube.com"));){
            String clientVersion;
            HttpClientTools.assertSuccessWithContent((HttpResponse)response, (String)"client config fetch");
            this.lastConfigUpdate = System.currentTimeMillis();
            String page = EntityUtils.toString((HttpEntity)response.getEntity());
            Matcher m = CONFIG_REGEX.matcher(page);
            if (!m.find()) {
                log.warn("Unable to find youtube client config in base page, html: {}", (Object)page);
                return;
            }
            JsonBrowser json = JsonBrowser.parse((String)m.group(1));
            JsonBrowser client = json.get("INNERTUBE_CONTEXT").get("client");
            String apiKey = json.get("INNERTUBE_API_KEY").text();
            if (!apiKey.isEmpty()) {
                BASE_CONFIG.withApiKey(apiKey);
            }
            if (!client.isNull() && !(clientVersion = client.get("clientVersion").text()).isEmpty()) {
                BASE_CONFIG.withClientField("clientVersion", clientVersion);
            }
        }
        catch (IOException e) {
            throw ExceptionTools.toRuntimeException((Exception)e);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    @NotNull
    public ClientConfig getBaseClientConfig(@NotNull HttpInterface httpInterface) {
        if (this.lastConfigUpdate == -1L) {
            Web web = this;
            synchronized (web) {
                if (this.lastConfigUpdate == -1L) {
                    this.fetchClientConfig(httpInterface);
                }
            }
        }
        return BASE_CONFIG.copy();
    }

    @Override
    @NotNull
    public URI transformPlaybackUri(@NotNull URI originalUri, @NotNull URI resolvedPlaybackUri) {
        if (poToken == null) {
            return resolvedPlaybackUri;
        }
        log.debug("Applying 'pot' parameter on playback URI: {}", (Object)resolvedPlaybackUri);
        URIBuilder builder = new URIBuilder(resolvedPlaybackUri);
        builder.addParameter("pot", poToken);
        try {
            return builder.build();
        }
        catch (URISyntaxException e) {
            log.debug("Failed to apply 'pot' parameter.", (Throwable)e);
            return resolvedPlaybackUri;
        }
    }

    @Override
    @NotNull
    protected List<AudioTrack> extractSearchResults(@NotNull YoutubeAudioSourceManager source, @NotNull JsonBrowser json) {
        return json.get("contents").get("twoColumnSearchResultsRenderer").get("primaryContents").get("sectionListRenderer").get("contents").values().stream().flatMap(item -> item.get("itemSectionRenderer").get("contents").values().stream()).map(item -> this.extractAudioTrack(item.get("videoRenderer"), source)).filter(Objects::nonNull).collect(Collectors.toList());
    }

    @Override
    @NotNull
    protected JsonBrowser extractMixPlaylistData(@NotNull JsonBrowser json) {
        return json.get("contents").get("twoColumnWatchNextResults").get("playlist").get("playlist");
    }

    @Override
    protected String extractPlaylistName(@NotNull JsonBrowser json) {
        return json.get("metadata").get("playlistMetadataRenderer").get("title").text();
    }

    @Override
    @NotNull
    protected JsonBrowser extractPlaylistVideoList(@NotNull JsonBrowser json) {
        return json.get("contents").get("twoColumnBrowseResultsRenderer").get("tabs").index(0).get("tabRenderer").get("content").get("sectionListRenderer").get("contents").index(0).get("itemSectionRenderer").get("contents").index(0).get("playlistVideoListRenderer");
    }

    @Override
    @Nullable
    protected String extractPlaylistContinuationToken(@NotNull JsonBrowser videoList) {
        JsonBrowser contents = videoList.get("contents");
        if (!contents.isNull()) {
            videoList = contents;
        }
        return videoList.values().stream().filter(item -> !item.get("continuationItemRenderer").isNull()).findFirst().map(item -> {
            JsonBrowser continuationEndpoint = item.get("continuationItemRenderer").get("continuationEndpoint");
            String token = continuationEndpoint.get("continuationCommand").get("token").text();
            if (!DataFormatTools.isNullOrEmpty((String)token)) {
                return token;
            }
            return continuationEndpoint.get("commandExecutorCommand").get("commands").index(1).get("continuationCommand").get("token").text();
        }).orElse(null);
    }

    @Override
    @NotNull
    protected JsonBrowser extractPlaylistContinuationVideos(@NotNull JsonBrowser continuationJson) {
        return continuationJson.get("onResponseReceivedActions").index(0).get("appendContinuationItemsAction").get("continuationItems");
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
    @NotNull
    public String getIdentifier() {
        return BASE_CONFIG.getName();
    }
}
