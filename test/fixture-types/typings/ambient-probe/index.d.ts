// A global-only ambient type package, exactly the shape DefinitelyTyped ships for
// environment augmentations (@types/webgl-ext, @types/offscreencanvas, ...): nothing is
// exported, an interface is MERGED into an existing global, and no source file ever
// `import`s it. Such a package reaches the program only via automatic @types inclusion
// — the mechanism tsgo (TS7) turned off by defaulting `types` to `[]`.
//
// The merged member is REQUIRED, so its presence makes an otherwise-valid object
// literal invalid. That is the dangerous direction: dropping this package does not add
// a "cannot find name" error, it SILENTLY makes a real error disappear.
interface ProbeRegistry {
  fromAmbientPackage: 'required'
}
