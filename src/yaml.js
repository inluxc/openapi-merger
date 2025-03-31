"use strict";

import { dirname } from "path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { load, dump as _dump } from "js-yaml";
import { info } from "loglevel";

function loadYAML(str) {
  return load(str);
}

function readYAML(filePath) {
  const str = "" + readFileSync(filePath, "utf8");
  return load(str);
}

function writeYAML(doc, filePath) {
  const dump = _dump(doc, { lineWidth: 1000 });
  if (filePath) {
    const outputDir = dirname(filePath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    writeFileSync(filePath, dump);
  } else {
    info(dump);
  }
}

export {
  readYAML,
  writeYAML,
  loadYAML,
};
