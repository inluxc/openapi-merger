"use strict";

import fetch from "node-fetch";
import { cloneDeep } from "lodash";
import { loadYAML } from "./yaml";
import { warn, error } from "loglevel";

const cache = {};

/**
 * Download from URL.
 * @param url {string}
 * @returns
 */
async function download(url) {
  if (cache[url]) {
    return cloneDeep(cache[url]);
  }

  warn(`fetching: ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    error(`Failed to fetch: ${url}`);
    return {};
  }
  if (!res.ok) {
    error(`${res.status} returned: ${url}`);
    return {};
  }

  const body = await res.text();
  let doc;
  if (url.match(/\.(yml|yaml)$/)) {
    doc = loadYAML(body);
  } else if (url.match(/\.json$/)) {
    doc = JSON.parse(body);
  } else {
    warn(`Cannot determine the file type: ${url}`);
    // assume YAML for now
    doc = loadYAML(body);
  }

  cache[url] = doc;

  return cloneDeep(doc);
}

export default {
  download,
};
