'use strict';
var kss                 = require('kss'),
    path                = require('path'),
    Q                   = require('q'),
    gutil               = require('gulp-util'),
    kssSplitter         = require('./kss-splitter'),
    kssAdditionalParams = require('./kss-additional-params'),
    kssSanitizeParams   = require('./kss-sanitize-params'),
    marked              = require('marked'),
    _                   = require('lodash');

// Parses kss.KssSection to JSON
function jsonSections(sections) {
  return sections.map(function(section) {
    return {
      header: generateDescription(section.header(), {noWrapper: true}),
      description: generateDescription(section.description()),
      modifiers: jsonModifiers(section.modifiers()),
      deprecated: section.deprecated(),
      experimental: section.experimental(),
      reference: section.reference(),
      markup: section.markup() ? section.markup().toString() : null,
      weight: section.weight()
    };
  });
}

// Parses kss.KssModifier to JSON
function jsonModifiers(modifiers) {
  return modifiers.map(function(modifier, id) {
    return {
      id: id + 1,
      name: modifier.name(),
      description: modifier.description(),
      className: modifier.className(),
      markup: modifier.markup() ? modifier.markup().toString() : null
    };
  });
}

function trimLinebreaks(str) {
  // Remove leading and trailing linebreaks
  if (!str) {
    return str;
  }
  return str.replace(/^[\r\n]+|[\r\n]+$/g, '');
}

function generateDescription(string, options) {
  var desc = marked(string);
  if (options && options.noWrapper) {
    // Remove wrapping p tags
    desc = desc.replace(/^<p>/, '');
    desc = desc.replace(/<\/p>\n$/, '');
  }

  // HACK: Remove extra parameters from descriotion
  desc = desc.split(/sg\-[^:]*:/)[0];
  return desc;
}

function processBlock(block, options) {
  return Q.Promise(function(resolve, reject) {

    // Get additional params
    var additionalParams = kssAdditionalParams.get(block.kss);

    block.sanitizedKss = kssSanitizeParams(block.kss);

    // Parse with original KSS library
    kss.parse(block.sanitizedKss, options, function(err, styleguide) {
      var section,
          blockStyles;
      if (err) {
        console.error('  error processing kss block', err);
        reject(err);
        return false;
      } else {
        section = jsonSections(styleguide.section());

        if (section.length > 0) {
          if (section.length > 1) {
            console.warn('Warning: KSS splitter returned more than 1 KSS block. Styleguide might not be properly generated.');
          }
          blockStyles = trimLinebreaks(block.code);

          // Add extra parameters
          section[0] = _.assign(section[0], additionalParams);

          // Add related CSS to section
          if (blockStyles && blockStyles !== '') {
            section[0].css = blockStyles;
          }
        }
        resolve(section);
      }
    });
  });
}

function processFile(contents, filePath, syntax, options) {
  if (!contents || contents.length === 0) {
    return Q.resolve([]);
  }

  return Q.Promise(function(resolve, reject) {
    var blockPromises = [],
        blocks;
    try {
      blocks = kssSplitter.getBlocks(contents, syntax);

      // Process every block in the current file
      blocks.forEach(function(block) {
        blockPromises.push(processBlock(block, options));
      });
    } catch (err) {
      reject(err);
    }
    Q.all(blockPromises).then(function(results) {
      resolve(results.reduce(function(memo, result) {
        var blockResult = result.valueOf();
        if (blockResult && blockResult.length > 0) {
          // Map syntax to every block. This is later used when parsing used variables
          // Finally add sections to array
          return memo.concat(blockResult.map(function(currentBlock) {
            currentBlock.syntax = syntax;
            currentBlock.file = filePath;
            return currentBlock;
          }));
        }
        return memo;
      }, []));
    });
  });
}

function toInt(s) {
  return parseInt(s, 10);
}

function quote(s) {
  return '"' + s + '"';
}

function bySectionReference(x, y) {
  var xs = x.reference.split('.').map(toInt),
      ys = y.reference.split('.').map(toInt),
      len = Math.min(xs.length, ys.length),
      cmp, i;
  for (i = 0; i < len; i += 1) {
    cmp = xs[i] - ys[i];
    if (cmp !== 0) {
      return cmp;
    }
  }
  len = xs.length - ys.length;
  if (len === 0) {
    throw new gutil.PluginError('kss-parser', 'Two sections defined with same number ' +
    x.reference + ': ' + quote(x.header) + ' and ' + quote(y.header));
  }
  return len;
}


/**
 * A KssNodeSorter encapsulates the section sorting behavior found in kss-node.
 * @author Steve Henty (as cognivator) - limited to modifications to kss-node algorithms and encapsulating as an object.
 * @requires lodash
 *
 * To avoid polluting the original SC5 sections array, KssNodeSorter creates and operates on
 * a deep clone of the passed sections. This means you'll have to retrieve the sorted sections as a separate step
 * (see Usage).
 *
 * ## Operation
 * The primary advantage of using this kss-node style sorter is it properly deals with string-based Styleguide references
 * in the following ways unique to kss-node,
 *
 *   - sorts string references
 *   - modifies the normal alpha order of string references using the kss `weight` parameter
 *   - creates a numeric reference for each section
 *
 * ## Styleguide Reference characteristics
 * The `reference` property of the SC5 section will always be numerical following a KssNodeSorter sort. If the original
 * references are numerics, they remain unchanged. If the originals are strings, the string reference is stored in a
 * `stringReference` property, and the derived numeric is stored in the `reference` property.
 *
 * ## Usage
 * New up a KssNodeSorter with the SC5 sections array to be sorted, then call `.sort()`.
 * To retrieve the sorted array of sections, access the `.sections` property.
 *
 * @constructor
 * @param {Array} sections An array of kss sections (SC5 data structure, not the native KssSection object)
 * @returns {*} KssNodeSorter instance
 */
function KssNodeSorter(sections) {
  if (!(this instanceof KssNodeSorter)) {
    return new KssNodeSorter(sections);
  }

  var _this = this;

  // use a deep clone of sections
  this.sections  = sections ? _.clone(sections, true) : [];
  this.weightMap = initWeightMap();

  function initWeightMap() {
    return _.object(
      _.map(_this.sections, function(section, index) {
        return [
          section.reference.toLowerCase().replace(/\s+\-\s+/g, '.'),
          section.weight || 0
        ];
      })
    );
  }
}

/**
 * Sorts an array of kss sections like kss-node would.
 *
 * This is a slightly modified version of the sort algorithm found in kss-node's KssStyleguide class.
 */
KssNodeSorter.prototype.sort = function sort() {
  var _this = this;

  this.sections.sort(likeKssNode);
  convertKssReferenceString2Number();

  /**
   * Sort comparator based on kss-node section sorter.
   *
   * This is a slightly modified copy of the sort algorithm found in kss-node's KssStyleguide class. The modifications
   * accommodate the SC5 section data structure.
   *
   * @param {object} a One of the kss sections being compared during sort
   * @param {object} b The other kss section being compared during sort
   * @returns {number} (see Array sort comparator spec)
   */
  function likeKssNode(a, b) {
    // Split the 2 references into chunks by their period or dash seperators.
    var refsA = a.reference.toLowerCase().split(/(?:\.|\s\-\s)/),
        refsB = b.reference.toLowerCase().split(/(?:\.|\s\-\s)/),
        weightA, weightB,
        i, l  = Math.max(refsA.length, refsB.length);

    // Compare each set of chunks until we know which reference should be listed first.
    for (i = 0; i < l; i += 1) {
      if (refsA[i] && refsB[i]) {
        // If the 2 chunks are unequal, compare them.
        if (refsA[i] != refsB[i]) {
          // If the chunks have different weights, sort by weight.
          weightA = getWeight(a.reference, i);
          weightB = getWeight(b.reference, i);
          if (weightA != weightB) {
            return weightA - weightB;
          }
          // If both chunks are digits, use numeric sorting.
          else if (refsA[i].match(/^\d+$/) && refsB[i].match(/^\d+$/)) {
            return refsA[i] - refsB[i];
          }
          // Otherwise, use alphabetical string sorting.
          else {
            return (refsA[i] > refsB[i]) ? 1 : -1;
          }
        }
      } else {
        // If 1 of the chunks is empty, it goes first.
        return refsA[i] ? 1 : -1;
      }
    }

    return 0;
  }

  /**
   * Gets the reference weight of a section.
   *
   * This is a helper method for the sort algorithm found in kss-node's KssStyleguide class.
   *
   * @param {string} reference The reference extracted from the kss comment for the current section: Styleguide <reference>
   * @param {number} index The index of the current "chunk" of the reference being compared by the sort
   * @returns {number} weight of the section, or 0 (the default) if no weight given in the original kss comment
   */
  function getWeight(reference, index) {
    reference = reference.toLowerCase().replace(/\s+\-\s+/g, '.');
    if (typeof index !== 'undefined') {
      reference = reference.split('.', index + 1).join('.');
    }

    return _this.weightMap[reference] || 0;
  }

  /**
   * Convert a string Styleguide reference into a number reference.
   *
   * This is a helper method for the sort algorithm found in kss-node's KssStyleguide class. It has been modified to
   * accommodate the SC5 section data structure.
   */
  function convertKssReferenceString2Number() {
    var section,
        ref, previousRef = [], previousSection = {},
        autoIncrement    = [0], incrementIndex, index,
        i, l;

    // Loop through all the sections to initialize some computed values.
    l = _this.sections.length;
    for (i = 0; i < l; i += 1) {
      section = _this.sections[i];
      ref     = section.reference;

      // Compare the previous Ref to the new Ref.
      ref = ref.replace(/\s+\-\s+/g, '.').split('.');
      // If they are already equal, we don't need to increment the section number.
      // TODO:2 modify this to increment for completely same references, too? Avoids url and section number duplication, and no reason to error...?
      if (previousRef.join('.') != ref.join('.') || true) {
        incrementIndex = 0;
        for (index = 0; index < previousRef.length; index += 1) {
          // Find the index where the refs differ.
          if (index >= ref.length || previousRef[index] != ref[index]) {
            break;
          }
          incrementIndex = index + 1;
        }
        if (incrementIndex < autoIncrement.length) {
          // Increment the part where the refs started to differ.
          autoIncrement[incrementIndex]++;
          // Trim off the extra parts of the autoincrement where the refs differed.
          autoIncrement = autoIncrement.slice(0, incrementIndex + 1);
        } else {
          // TODO:2 modify this to increment for completely same references, too? Avoids url and section number duplication, and no reason to error...?
          throw new gutil.PluginError('kss-parser', 'Two sections defined with same reference ' +
          previousSection.reference + ': ' + quote(previousSection.header) + ' and ' + quote(section.header));
        }
        // Add parts to the autoincrement to ensure it is the same length as the new ref.
        for (index = autoIncrement.length; index < ref.length; index += 1) {
          autoIncrement[index] = 1;
        }
      }
      // If the current ref has any alpha (isn't all digits), then use the autoincrement number as reference
      if (!(/^[\d\.\-]+$/.test(section.reference))) {
        section.stringReference = section.reference;
        section.reference       = autoIncrement.join('.');
      }
      previousRef     = ref;
      previousSection = section;
    }
  }
};

module.exports = {
  // Parse node-kss object ( {'file.path': 'file.contents.toString('utf8'}' )
  parseKssSections: function(files, options) {
    return Q.Promise(function(resolve, reject) {
      var filePromises = [],
          sections = [];

      // Process every file
      Object.keys(files).forEach(function(filePath) {
        var contents = files[filePath],
            syntax = path.extname(filePath).substring(1);
        filePromises.push(processFile(contents, filePath, syntax, options));
      });
      // All files are processed
      Q.all(filePromises).then(function(results) {
        // Combine sections from every file to a single array
        results.map(function(result) {
          var fileSections = result.valueOf();
          if (fileSections && fileSections.length > 0) {
            sections = sections.concat(fileSections);
          }
        });

        // Sort sections by reference number and call main promise
        try {
          //sections.sort(bySectionReference);
          var kns            = new KssNodeSorter(sections);
          kns.sort();
          var sortedSections = kns.sections;
          resolve(sortedSections);
        } catch (err) {
          reject(err);
        }
      }).catch(reject);
    });
  }
};
