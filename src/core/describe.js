'use strict';

// Description precedence (FR-008, design §3.3): note > image label > compose
// > image ref. Pure — the note lookup happens before, in the store.
//
// The `sources` list is the provenance line under the description
// ("Source: your note · stack-a / api · “…” (image)"); its display order is
// note · compose · image, per the wireframe, independent of precedence.

const IMAGE_LABEL_KEYS = [
  'org.opencontainers.image.description',
  'org.opencontainers.image.title',
  'description'
];

function pickImageLabel(imageLabels) {
  if (!imageLabels) return null;
  for (const key of IMAGE_LABEL_KEYS) {
    const v = imageLabels[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function describe({ note, imageLabels, compose, imageRef }) {
  const labelText = pickImageLabel(imageLabels);
  const composeText = compose && compose.project
    ? `${compose.project} / ${compose.service || '?'}`.trim()
    : null;

  const sources = [];
  if (note) sources.push({ kind: 'note', label: 'your note', text: note });
  if (composeText) sources.push({ kind: 'compose', label: composeText, text: composeText });
  if (labelText) sources.push({ kind: 'image', label: `“${labelText}” (image)`, text: labelText });

  // precedence: note > image label > compose > image ref
  let primary = null;
  if (note) primary = note;
  else if (labelText) primary = labelText;
  else if (composeText) primary = composeText;
  else if (imageRef) primary = imageRef;

  return { primary, sources };
}

module.exports = { describe, pickImageLabel, IMAGE_LABEL_KEYS };
