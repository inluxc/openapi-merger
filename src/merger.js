"use strict";

import { resolve, dirname, relative, posix, basename as _basename, extname } from "path";
import { resolve as _resolve } from "url";
import { sync } from "glob";
import { merge as _merge, isObject, isArray } from "lodash";
import { readYAML } from "./yaml";
import { getRefType, shouldInclude } from "./ref";
import { download } from "./http";
import { sliceObject, parseUrl, filterObject, appendObjectKeys, prependObjectKeys, mergeOrOverwrite, IncludedArray } from "./util";
import { ComponentManager, ComponentNameResolver } from "./components";
import { debug, warn } from "loglevel";

class Merger {
  static INCLUDE_PATTERN = /^\$include(#\w+?)?(\.\w+?)?$/;

  constructor(config) {
    this.config = config;
  }

  // noinspection JSUnusedGlobalSymbols
  /**
   * Merge OpenAPI document into the single file.
   * @param doc {object} OpenAPI document object
   * @param docPath {string} OpenAPI document file path
   * @returns merged OpenAPI object
   */
  merge = async (doc, docPath) => {
    docPath = resolve(process.cwd(), docPath);
    this.baseDir = dirname(docPath);

    // convert to posix style path.
    // this path works with fs module like a charm on both windows and unix.
    docPath = parseUrl(docPath).path;

    // 1st merge: list all components
    this.manager = new ComponentManager();
    await this.mergeRefs(doc, docPath, "$");

    // resolve component names in case of conflict
    const nameResolver = new ComponentNameResolver(this.manager.components);

    // 2nd merge: merge them all
    this.manager = new ComponentManager(nameResolver);
    doc = await this.mergeRefs(doc, docPath, "$");
    doc.components = _merge(doc.components, this.manager.getComponentsSection());
    return doc;
  };

  /**
   * Merges remote/URL references and inclusions in an object recursively.
   * @param obj a target object or array
   * @param file the name of the file containing the target object
   * @param jsonPath a JSON path for accessing the target object
   * @returns {Promise<*[]|*>} a merged object or array
   */
  mergeRefs = async (obj, file, jsonPath) => {
    if (!isObject(obj)) {
      return obj;
    }
    let ret = isArray(obj) ? [] : {};
    for (const [key, val] of Object.entries(obj)) {
      if (this.isRef(key, jsonPath)) {
        await this.handleRef(ret, key, val, file, jsonPath);
      } else if (this.isInclude(key)) {
        ret = await this.handleInclude(ret, key, val, file, jsonPath);
      } else {
        // go recursively
        const merged = await this.mergeRefs(val, file, `${jsonPath}.${key}`);
        // merge arrays or objects according their type
        if (merged instanceof IncludedArray && isArray(ret)) {
          ret = mergeOrOverwrite(ret, merged);
        } else {
          ret[key] = mergeOrOverwrite(ret[key], merged);
        }
      }
    }
    return ret;
  };

  isRef = (key, jsonPath) => {
    return key === "$ref" || jsonPath.endsWith("discriminator.mapping");
  };

  /**
   * Converts a remote/URL reference into local ones.
   * @param obj an object with a reference
   * @param key the key of the reference
   * @param val the value of the reference
   * @param file a name of the file containing the target object
   * @param jsonPath a JSON path for accessing the target object
   */
  handleRef = async (obj, key, val, file, jsonPath) => {
    debug(`ref    : ${jsonPath} file=${relative(this.baseDir, file)}`);

    obj[key] = mergeOrOverwrite(obj[key], val);

    const pRef = parseUrl(val);
    const pFile = parseUrl(file);

    const refType = getRefType(jsonPath);
    if (shouldInclude(refType)) {
      await this.handleInclude(obj, key, val, file, jsonPath);
      return;
    }

    let cmp, nextFile, cmpExists;
    if (pRef.isHttp) {
      // URL ref
      cmpExists = this.manager.exists(pRef.href);
      cmp = await this.manager.getOrCreate(refType, pRef.href);
      nextFile = pRef.hrefWoHash;
    } else if (pRef.isLocal) {
      // local ref
      // avoid infinite loop
      if (this.manager.exists(val)) {
        return;
      }
      const href = pFile.hrefWoHash + (pRef.hash === "#/" ? "" : pRef.hash);
      cmpExists = this.manager.exists(href);
      cmp = await this.manager.getOrCreate(refType, href);
      nextFile = pFile.hrefWoHash;
    } else {
      // remote ref
      let target;
      if (pFile.isHttp) {
        target = _resolve(dirname(pFile.hrefWoHash) + "/", val);
      } else {
        target = posix.join(posix.dirname(pFile.hrefWoHash), val);
      }
      const parsedTarget = parseUrl(target);
      cmpExists = this.manager.exists(target);
      cmp = await this.manager.getOrCreate(refType, target);
      nextFile = parsedTarget.hrefWoHash;
    }
    obj[key] = cmp.getLocalRef();
    // avoid infinite loop on recursive definition
    if (!cmpExists) {
      cmp.content = await this.mergeRefs(cmp.content, nextFile, `${jsonPath}.${key}`);
    }
  };

  isInclude = (key) => {
    return key.match(Merger.INCLUDE_PATTERN);
  };

  /**
   * Convert an inclusion into its contents.
   * @param obj an object with an inclusion
   * @param key the key of the inclusion
   * @param val the value of the inclusion
   * @param file a name of the file containing the target object
   * @param jsonPath a JSON path for accessing the target object
   * @returns {Promise<*>} a result object or array
   */
  handleInclude = async (obj, key, val, file, jsonPath) => {
    debug(`include: ${jsonPath} file=${relative(this.baseDir, file)}`);

    obj[key] = mergeOrOverwrite(obj[key], val);

    const pRef = parseUrl(val);
    const pFile = parseUrl(file);

    let content, nextFile;
    if (pRef.isHttp) {
      // URL ref
      content = await download(pRef.hrefWoHash);
      nextFile = pRef.hrefWoHash;
    } else if (pRef.isLocal) {
      // local ref
      // avoid infinite loop
      if (this.manager.get(val)) {
        return obj;
      }
      content = readYAML(file);
      nextFile = pFile.hrefWoHash;
    } else {
      // remote ref
      let target;
      if (pFile.isHttp) {
        target = _resolve(dirname(pFile.hrefWoHash) + "/", val);
      } else {
        target = posix.join(posix.dirname(pFile.hrefWoHash), val);
      }
      const parsedTarget = parseUrl(target);
      if (parsedTarget.isHttp) {
        content = await download(parsedTarget.hrefWoHash);
      } else {
        // handle glob pattern
        content = {};
        if (parsedTarget.hrefWoHash.includes("*")) {
          const matchedFiles = sync(parsedTarget.hrefWoHash).map((p) =>
            relative(dirname(pFile.hrefWoHash), p),
          );
          // include multiple files
          for (const mf of matchedFiles) {
            const basename = _basename(mf, extname(mf));
            content[basename] = await this.handleInclude({ [key]: mf }, key, mf, file, `${jsonPath}.${basename}`);
          }
        } else {
          // include a single file
          content = readYAML(parsedTarget.hrefWoHash);
        }
      }
      nextFile = parsedTarget.hrefWoHash;
    }
    const sliced = sliceObject(content, pRef.hash);
    const merged = await this.mergeRefs(sliced, nextFile, jsonPath);
    if (isArray(merged)) {
      if (isArray(obj)) {
        // merge array
        obj = obj.concat(merged);
      } else if (Object.keys(obj).length === 1) {
        // object having one and only $include key, turn into array.
        obj = IncludedArray.from(merged);
      } else {
        throw new Error(`cannot merge array content object. $include: ${val} at jsonPath=${jsonPath}`);
      }
    } else {
      // merge object
      const processed = processInclude(key, merged, this.config);
      _merge(obj, processed);
      delete obj[key];
    }
    return obj;
  };
}

function processInclude(key, obj, config) {
  const clazz = getIncludeClass(key);
  if (!clazz) {
    return obj;
  }
  const clazzConfig = config.include[clazz];
  if (!clazzConfig) {
    warn(`$include classname '${clazz} specified, but no configuration found.`);
    return obj;
  }
  obj = filterObject(obj, clazzConfig.filter);
  obj = appendObjectKeys(obj, clazzConfig.prefix);
  obj = prependObjectKeys(obj, clazzConfig.suffix);
  return obj;
}

function getIncludeClass(key) {
  const groups = key.match(Merger.INCLUDE_PATTERN);
  const pattern = groups ? groups[2] : null;
  return pattern ? pattern.substr(1) : null;
}

export default Merger;
