; Python definitions and references for Moon's project map.
; Copied unchanged from Aider (https://github.com/Aider-AI/aider, Apache-2.0), file
; aider/queries/tree-sitter-language-pack/python-tags.scm, which adapts the tags query of
; https://github.com/tree-sitter/tree-sitter-python (MIT License). See NOTICE.md.

(module (expression_statement (assignment left: (identifier) @name.definition.constant) @definition.constant))

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
      (identifier) @name.reference.call
      (attribute
        attribute: (identifier) @name.reference.call)
  ]) @reference.call
