"""
Import a GLB exported by the studio into Blender and compare it with the design file.

  blender -b --factory-startup -P tools/blender/verify_glb.py -- --glb design.glb --design design.json

Checks that every piece arrives with 4 vertices, 3 faces, the stored vertex order, and world
coordinates (Blender meters, board in the XY plane) equal to the design's tips and the 75% rule.
"""
import argparse
import json
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--glb", required=True)
ap.add_argument("--design", required=True)
ap.add_argument("--canonical", default="public/assets/sculpture.json")
args = ap.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.glb, merge_vertices=False)
design = json.load(open(args.design))
canon = json.load(open(args.canonical))
pieces = sorted(canon["pieces"], key=lambda p: (p["row"], p["col"]))
tips = design["pose"]["tips"]

tip_err = base_err = inner_err = 0.0
topology_ok = True
missing = []
for i, p in enumerate(pieces):
    ob = bpy.data.objects.get(p["id"])
    oi = bpy.data.objects.get(p["id"] + " INNER 75%")
    if ob is None or oi is None:
        missing.append(p["id"])
        continue
    me, mi = ob.data, oi.data
    if len(me.vertices) != 4 or len(me.polygons) != 3 or len(mi.vertices) != 4 or len(mi.polygons) != 3:
        topology_ok = False
    if [list(poly.vertices) for poly in me.polygons] != p["faces"]:
        topology_ok = False
    w = [ob.matrix_world @ v.co * 1000.0 for v in me.vertices]
    wi = [oi.matrix_world @ v.co * 1000.0 for v in mi.vertices]
    tip_err = max(tip_err, (w[p["apex"]] - Vector(tips[i])).length)
    for k in range(4):
        if k != p["apex"]:
            base_err = max(base_err, (w[k] - Vector(p["vertices"][k])).length)
    m = (w[p["right"]] + w[p["up"]]) / 2
    for a, b in zip(w, wi):
        inner_err = max(inner_err, ((m + 0.75 * (a - m)) - b).length)

print("GLB_REPORT " + json.dumps({
    "glb": args.glb, "piecesFound": len(pieces) - len(missing), "missing": missing[:5],
    "topologyPreserved": topology_ok, "tipMaxErrorMm": tip_err, "baseMaxErrorMm": base_err,
    "innerRuleMaxErrorMm": inner_err, "board": [o.name for o in bpy.data.objects if o.name.startswith("Backing board")],
}))
