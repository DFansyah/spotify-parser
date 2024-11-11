#!/usr/bin/env node

'use strict';

const readline = require('readline');
const spotifyURI = require('spotify-uri');
const { parse: parseHTML } = require('himalaya');

async function fetchData(url, options) {
  const { default: fetch } = await import('node-fetch');
  return fetch(url, options);
}

const SPOTIFY_TYPES = {
  ALBUM: 'album',
  ARTIST: 'artist',
  EPISODE: 'episode',
  PLAYLIST: 'playlist',
  TRACK: 'track'
};

const ERROR_MESSAGES = {
  REPORT_ISSUE: 'Please report the problem to owner',
  NO_EMBED_DATA: "Couldn't find any data in the embed page that we know how to parse.",
  NO_SCRIPT_TAGS: "Couldn't find any scripts to get the data."
};

const SUPPORTED_SPOTIFY_TYPES = Object.values(SPOTIFY_TYPES);

const throwError = (message, html) => {
  const error = new TypeError(`${message}\n${ERROR_MESSAGES.REPORT_ISSUE}`);
  error.html = html;
  throw error;
};

const parseSpotifyData = (html) => {
  const parsedHTML = parseHTML(html);

  let htmlElement = parsedHTML.find(el => el.tagName === 'html');
  if (htmlElement === undefined) return throwError(ERROR_MESSAGES.NO_SCRIPT_TAGS, html);

  let scriptTags = htmlElement.children
    .find(el => el.tagName === 'body')
    .children.filter(({ tagName }) => tagName === 'script');

  let resourceScript = scriptTags.find(script =>
    script.attributes.some(({ value }) => value === 'resource')
  );

  if (resourceScript !== undefined) {
    return normalizeSpotifyData({
      data: JSON.parse(Buffer.from(resourceScript.children[0].content, 'base64'))
    });
  }

  let initialStateScript = scriptTags.find(script =>
    script.attributes.some(({ value }) => value === 'initial-state')
  );

  if (initialStateScript !== undefined) {
    const data = JSON.parse(Buffer.from(initialStateScript.children[0].content, 'base64')).data.entity;
    return normalizeSpotifyData({ data });
  }

  let nextDataScript = scriptTags.find(script =>
    script.attributes.some(({ value }) => value === '__NEXT_DATA__')
  );

  if (nextDataScript !== undefined) {
    const jsonData = Buffer.from(nextDataScript.children[0].content);
    const data = JSON.parse(jsonData).props.pageProps.state?.data.entity;
    if (data !== undefined) return normalizeSpotifyData({ data });
  }

  return throwError(ERROR_MESSAGES.NO_EMBED_DATA, html);
};

const createGetSpotifyData = (fetchFunc) => async (url, options) => {
  const embedUrl = generateSpotifyEmbedUrl(url);
  const response = await fetchFunc(embedUrl, options);
  const responseText = await response.text();
  return parseSpotifyData(responseText);
};

function generateSpotifyEmbedUrl(url) {
  try {
    const parsedURL = spotifyURI.parse(url);
    if (!parsedURL.type) throw new TypeError();
    return spotifyURI.formatEmbedURL(parsedURL);
  } catch (_) {
    throw new TypeError(`Couldn't parse '${url}' as a valid Spotify URL`);
  }
}

const extractImages = (data) => data.coverArt?.sources || data.images;

const extractReleaseDate = (data) => data.releaseDate?.isoString || data.release_date;

const generateOpenSpotifyLink = (data) => spotifyURI.formatOpenURL(data.uri);

function extractTrackArtist(track) {
  return track.show
    ? track.show.publisher
    : track.artists
        .filter(Boolean)
        .map(artist => artist.name)
        .join(', ');
}

const extractTracks = (data) =>
  data.trackList ? data.trackList.map(formatTrackData) : [formatTrackData(data)];

function generatePreviewData(data) {
  const [firstTrack] = extractTracks(data);
  const releaseDate = extractReleaseDate(data);

  return {
    "Release Date": releaseDate ? new Date(releaseDate).toISOString() : releaseDate,
    "Title": data.name,
    "Type": data.type,
    "Track Name": firstTrack.name,
    "Description": data.description || data.subtitle || firstTrack.description,
    "Artist": firstTrack.artist,
    "Image URL": extractImages(data).reduce((largest, current) => (largest.width > current.width ? largest : current)).url,
    "Audio Preview URL": firstTrack.previewUrl,
    "Spotify Link": generateOpenSpotifyLink(data),
    "Embed URL": `https://embed.spotify.com/?uri=${data.uri}`
  };
}

const formatTrackData = (track) => ({
  artist: extractTrackArtist(track) || track.subtitle,
  duration: track.duration,
  name: track.title,
  previewUrl: track.isPlayable ? track.audioPreview.url : undefined,
  uri: track.uri
});

const normalizeSpotifyData = ({ data }) => {
  if (!data || !data.type || !data.name) {
    throw new Error("The provided data does not have the expected structure to parse.");
  }

  if (!SUPPORTED_SPOTIFY_TYPES.includes(data.type)) {
    throw new Error(
      `Invalid type. Supported types are ${SUPPORTED_SPOTIFY_TYPES.join(', ')}.`
    );
  }

  data.type = data.uri.split(':')[1];

  return data;
};

// Interactive CLI using readline
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Enter command (preview or tracks) and Spotify URL: ', async (input) => {
  const [command, url] = input.split(' ');

  try {
    const getSpotifyData = createGetSpotifyData(fetchData);

    if (command === 'preview') {
      const data = await getSpotifyData(url);
      console.log("Spotify Preview Information:");
      console.log(JSON.stringify(generatePreviewData(data), null, 2));
    } else if (command === 'tracks') {
      const data = await getSpotifyData(url);
      console.log("Spotify Track Details:");
      console.log(JSON.stringify(extractTracks(data), null, 2));
    } else {
      console.error('Unknown command. Please use "preview" or "tracks".');
    }
  } catch (error) {
    console.error("Error:", error.message);
  }

  rl.close();
});
