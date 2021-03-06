'use strict';

var vfs = require('vinyl-fs'),
  md = require('markdown-it')({
    html: true
  }),
  through = require('through2'),
  cheerio = require('cheerio'),
  excludeLinks = [
    'https://travis-ci.org/SC5/sc5-styleguide',
    'https://david-dm.org/SC5/sc5-styleguide'
  ];

function dasherize(str) {
  return str.replace(/\s/ig, '-').toLowerCase();
}

module.exports = {
  getStream: function(filePath) {
    return vfs.src(filePath)
      .pipe(this.processStream());
  },

  processStream: function() {
    var _this = this,
    throughOpts = {
      objectMode: true,
      allowHalfOpen: false
    };

    function bufferFileContents(file, enc, done) {
      file.contents = new Buffer(_this.render(file.contents.toString()));
      // jshint -W040
      this.push(file);
      // jshint +W040
      done();
    }

    return through(throughOpts, bufferFileContents, function(cb) {
      cb();
    });
  },

  render: function(string) {
    if (!string) {
      return '';
    }
    return this.processHtml(md.render(string));
  },

  processHtml: function(html) {
    var $ = cheerio.load(html);
    $('p, a, li, pre, h1, h2, h3, h4, h5, h6').addClass('sg');
    excludeLinks.forEach(function(link) {
      $('a[href^="' + link + '"]').remove();
    });
    $('h1, h2, h3, h4, h5, h6').each(function() {
      $(this).attr('name', dasherize($(this).text()));
    });
    return $.html();
  }
};
