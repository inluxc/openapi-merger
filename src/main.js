"use strict";

import { readYAML, writeYAML } from "./yaml";
import Merger from "./merger";

export default async function merger(params) {
  let doc = await readYAML(params.input);
  let config = {};
  if (params.config) {
    config = await readYAML(params.config);
  }

  const merger = new Merger(config);
  doc = await merger.merge(doc, params.input);

  writeYAML(doc, params.output);
}