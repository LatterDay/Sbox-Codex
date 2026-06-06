# s&box SDK limitations blocking editor automation

I'm building an editor automation tool for s&box. It drives the editor from a C# addon together with an external helper process. Along the way I've hit a handful of SDK limitations that can't be worked around from addon code — they need engine-side changes. These are listed roughly in priority order.

## 1. Editor addons can't open a socket, so there's no clean way to talk to a local process

`System.Net` is blocked in the sandbox — `HttpListener`, `WebSocket`, and `TcpListener` are all unavailable. The only way I've found to communicate with an external helper process is to poll JSON files in a shared temp directory, which is slow and unreliable.

Would you consider a sanctioned local IPC path for editor addons — a whitelisted localhost socket or named pipe, or a first-class "external tool" channel? This is the single biggest thing standing in the way of editor automation.

## 2. No way to compile a `.vpcf` from an addon

Compiling materials from addon code works fine — `Editor.AssetSystem.RegisterFile(path).Compile()` turns a `.vmat` into a `.vmat_c` without any trouble. The exact same call on a `.vpcf` fails with `Failed to find compiler for .vpcf`. It looks like the particle compiler just isn't registered in the editor assembly an addon runs in.

Could the particle `ResourceCompiler` be exposed through `AssetSystem` the same way the material one is? That would let a tool generate a particle file as text and compile it without having to open the particle editor by hand.

## 3. `System.Math` / `System.MathF` aren't available in the sandbox, and `MathX` is missing a lot

Sandboxed code can't call `MathF.Sin`, `Math.Abs`, and similar. `MathX` is the fallback, but it doesn't include `Abs`, `Min`, `Max`, `Sin`, `Cos`, `Tan`, `Atan2`, `Sqrt`, `Pow`, or `PI`/`Tau`, so routine gameplay math has to be reimplemented by hand.

Could `System.Math`/`System.MathF` be whitelisted, or `MathX` filled out to cover the common functions?

## 4. `Cloud.Model` (and `Cloud.Texture`/`Cloud.Sound`) only accept string literals

These are source-generated and won't take a variable, so there's no way to load a cloud asset whose identifier is decided at runtime or read from config. A runtime equivalent — something like `Cloud.Load(string ident)` that resolves at runtime — would cover the data-driven case.

## 5. `SetFaceMaterial` and the `Color` tint don't show up on a code-built `PolygonMesh`

I can generate a `PolygonMesh` and it renders fine, but `MeshComponent.SetFaceMaterial(face, material)` and `MeshComponent.Color` have no visible effect — the mesh keeps showing its default material. The calls succeed, but nothing changes on screen. This looks like a rendering bug rather than a missing feature.

## 6. No way to capture the editor viewport (or an arbitrary camera) to an image

Screenshots can only be rendered from the scene's Main Camera. Moving the editor viewport doesn't change what gets captured, so the only way to grab a specific angle is to temporarily move the Main Camera and then put it back.

An API to render the active viewport — or any given camera/transform — to an image would make visual checks far easier.

---

Happy to provide a minimal repro or more detail on any of these.
