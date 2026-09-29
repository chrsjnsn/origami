"""
Rebuild an Origami 1829 design in Blender from a design file saved by the browser studio.

Usage:

  blender -b --factory-startup -P rebuild_design.py -- \
      --design my-design.json --out my-design.blend [--data DIR] [--compare original.blend]

DIR must contain sculpture.json, sculpture-blender.json and presentation.json (the files that
ship next to this script in the Blender package, or public/assets/ in the project). By default
the script looks next to itself, then next to the design file.

What it builds, matching origami1829-final-vision.blend:
  * 522 outer shells with the original object names, vertex order and faces (open hypotenuse
    face), fixed base vertices, and the design's tip positions.
  * 522 inner shells rebuilt with inner = M + 0.75 (outer - M), M = midpoint of the base diagonal.
  * Presentation-only Solidify / Bevel modifiers (0.45 mm outer, 0.25 mm inner), the procedural
    matte-black and #007AFF materials, the board at the design's saved size, and the studio
    (backdrop, three softbox lights, three cameras).

With --compare, the rebuilt shells are compared vertex by vertex with an existing .blend and a
JSON report is printed.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

MM = 1000.0
INNER_SCALE = 0.75


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--design", required=True, help="Design file (.json) from the browser studio")
    p.add_argument("--out", required=True, help="Output .blend path")
    p.add_argument("--data", default=None, help="Folder with sculpture.json, sculpture-blender.json, presentation.json")
    p.add_argument("--compare", default=None, help="Optional .blend to compare the rebuilt shells against")
    p.add_argument("--no-studio", action="store_true", help="Skip backdrop, lights and cameras")
    return p.parse_args(argv)


def find_data_dir(explicit, design_path):
    candidates = [explicit] if explicit else []
    here = os.path.dirname(os.path.abspath(__file__))
    candidates += [here, os.path.dirname(os.path.abspath(design_path)),
                   os.path.join(here, "..", "..", "public", "assets")]
    for c in candidates:
        if c and all(os.path.exists(os.path.join(c, f)) for f in ("sculpture.json", "sculpture-blender.json", "presentation.json")):
            return os.path.abspath(c)
    raise SystemExit("Could not find sculpture.json, sculpture-blender.json and presentation.json. Pass --data DIR.")


def load(path):
    with open(path) as f:
        return json.load(f)


def mat_apply(rows, v):
    """4x4 matrix (row lists) applied to a 3-vector in double precision."""
    return [rows[r][0] * v[0] + rows[r][1] * v[1] + rows[r][2] * v[2] + rows[r][3] for r in range(3)]


def invert_rigid(rows):
    """Inverse of a rotation + translation matrix, in double precision."""
    R = [[rows[r][c] for c in range(3)] for r in range(3)]
    t = [rows[r][3] for r in range(3)]
    Rt = [[R[c][r] for c in range(3)] for r in range(3)]
    ti = [-(Rt[r][0] * t[0] + Rt[r][1] * t[1] + Rt[r][2] * t[2]) for r in range(3)]
    return [Rt[0] + [ti[0]], Rt[1] + [ti[1]], Rt[2] + [ti[2]], [0.0, 0.0, 0.0, 1.0]]


# ------------------------------------------------------------------------------------------------
# Materials (recreated from presentation.json, same node setup as the original file)
# ------------------------------------------------------------------------------------------------

def paper_material(info, bump_default):
    mat = bpy.data.materials.new(info["name"])
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    bump = nt.nodes.new("ShaderNodeBump")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    pr = info.get("principled", {})
    for key in ("Roughness", "Metallic", "IOR", "Specular IOR Level"):
        if key in pr and key in bsdf.inputs:
            bsdf.inputs[key].default_value = pr[key]
    nz = info.get("noise", {})
    if hasattr(noise, "noise_type"):
        noise.noise_type = "FBM"
    noise.noise_dimensions = "3D"
    noise.inputs["Scale"].default_value = nz.get("scale_per_m", 4800.0)
    noise.inputs["Detail"].default_value = nz.get("detail", 2.5)
    noise.inputs["Roughness"].default_value = nz.get("roughness", 0.72)
    noise.inputs["Lacunarity"].default_value = nz.get("lacunarity", 2.0)
    bp = info.get("bump", {})
    bump.inputs["Strength"].default_value = bp.get("strength", bump_default)
    bump.inputs["Distance"].default_value = bp.get("distance_m", 0.0001)
    stops = info.get("ramp", [])
    if len(stops) >= 2:
        els = ramp.color_ramp.elements
        els[0].position = stops[0]["position"]
        els[0].color = (*stops[0]["linear_rgb"], 1.0)
        els[1].position = stops[1]["position"]
        els[1].color = (*stops[1]["linear_rgb"], 1.0)
    links = nt.links
    links.new(coord.outputs["Object"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def srgb_to_linear(hex_color):
    h = hex_color.lstrip("#")
    out = []
    for k in range(3):
        c = int(h[2 * k:2 * k + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def with_color(info, hex_color, name):
    """Material info with its color ramp moved to a new base color (sRGB hex).

    The ramp stops keep their ratio to the Principled Base Color of the original material
    (about 0.74x and 1.17x), so the paper grain looks the same in any color.
    """
    if not hex_color:
        return info
    base = (info.get("principled", {}).get("Base Color") or [1, 1, 1])[:3]
    target = srgb_to_linear(hex_color)
    out = dict(info)
    out["name"] = name
    stops = []
    for st in info.get("ramp", []):
        ratio = [st["linear_rgb"][k] / base[k] if base[k] > 1e-6 else 1.0 for k in range(3)]
        # Use the brightest channel's ratio so hues without that channel keep their proportions.
        kmax = max(range(3), key=lambda k: base[k])
        r = ratio[kmax]
        stops.append({"position": st["position"], "linear_rgb": [target[k] * r for k in range(3)]})
    out["ramp"] = stops
    return out


def ramp_upper(mat):
    for node in mat.node_tree.nodes:
        if node.type == "VALTORGB":
            return tuple(round(c, 6) for c in node.color_ramp.elements[-1].color[:3])
    return ()


def plain_material(name, color, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add_presentation_modifiers(obj, thickness_mm, offset):
    sol = obj.modifiers.new("Paper thickness - presentation only", "SOLIDIFY")
    sol.thickness = thickness_mm / MM
    sol.offset = offset
    sol.use_even_offset = False
    sol.use_rim = True
    bev = obj.modifiers.new("Soft paper edges - presentation only", "BEVEL")
    bev.width = 0.055 / MM
    bev.segments = 2
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(30)
    bev.use_clamp_overlap = True


# ------------------------------------------------------------------------------------------------

def main():
    args = parse_args()
    design = load(args.design)
    if design.get("format") != "origami1829-design":
        raise SystemExit("Not an Origami 1829 design file")
    data_dir = find_data_dir(args.data, args.design)
    canon = load(os.path.join(data_dir, "sculpture.json"))
    source = load(os.path.join(data_dir, "sculpture-blender.json"))
    pres = load(os.path.join(data_dir, "presentation.json"))

    pieces = sorted(canon["pieces"], key=lambda p: (p["row"], p["col"]))
    ids = [p["id"] for p in pieces]
    if design["pieceIds"] != ids:
        raise SystemExit("The design's pieces do not match sculpture.json")
    tips = design["pose"]["tips"]
    by_id = {p["id"]: p for p in source["pieces"]}
    M = source["shellMatrixWorld"]
    Minv = invert_rigid(M)
    M_bpy = Matrix(M)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Scene"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "MILLIMETERS"
    scene.render.engine = "CYCLES"
    scene.view_settings.view_transform = pres["renderLook"].get("viewTransform", "Standard")
    scene.view_settings.exposure = pres["renderLook"].get("exposure", -0.8)
    scene.render.resolution_x, scene.render.resolution_y = 2000, 1500

    col_outer = bpy.data.collections.new("01 Matte black outer pyramids")
    col_inner = bpy.data.collections.new("02 Blue inner pyramids - 75 percent")
    col_studio = bpy.data.collections.new("03 Board and studio")
    for c in (col_outer, col_inner, col_studio):
        scene.collection.children.link(c)

    colors = design.get("colors") or {}
    mat_outer = paper_material(with_color(pres["materials"]["outer"], colors.get("outer"), "Outer paper " + str(colors.get("outer"))), 0.24)
    mat_inner = paper_material(with_color(pres["materials"]["inner"], colors.get("inner"), "Inner paper " + str(colors.get("inner"))), 0.12)
    mat_board = (
        paper_material(with_color(pres["materials"]["outer"], colors.get("board"), "Board " + str(colors.get("board"))), 0.24)
        if colors.get("board")
        else mat_outer
    )

    inner_err = 0.0
    mid_err = 0.0
    tip_err = 0.0
    edited = 0
    for i, p in enumerate(pieces):
        bp = by_id[p["id"]]
        apex, right, up = p["apex"], p["right"], p["up"]
        world = [list(v) for v in p["vertices"]]  # mm, double precision
        tip = tips[i]
        orig_tip = world[apex]
        changed = max(abs(tip[k] - orig_tip[k]) for k in range(3)) > 1e-9
        world[apex] = list(tip)
        outer_local = [list(v) for v in bp["outerLocal"]]
        if changed:
            edited += 1
            outer_local[apex] = mat_apply(Minv, [c / MM for c in tip])
        # Inner rule, evaluated in board coordinates (double precision), then stored locally.
        m = [(world[right][k] + world[up][k]) / 2 for k in range(3)]
        inner_world = [[m[k] + INNER_SCALE * (v[k] - m[k]) for k in range(3)] for v in world]
        inner_local = [mat_apply(Minv, [c / MM for c in v]) for v in inner_world]

        me = bpy.data.meshes.new(bp["outerMesh"])
        me.from_pydata([tuple(v) for v in outer_local], [], [tuple(f) for f in bp["faces"]])
        me.materials.append(mat_outer)
        ob = bpy.data.objects.new(bp["outerName"], me)
        ob.matrix_world = M_bpy
        col_outer.objects.link(ob)
        for k, v in bp["outerProps"].items():
            ob[k] = v
        ob["design_name"] = design.get("name", "")
        ob["design_tip_mm"] = list(tip)
        add_presentation_modifiers(ob, canon["presentation"]["outerThicknessMm"], 1.0)

        mi = bpy.data.meshes.new(bp["innerMesh"])
        mi.from_pydata([tuple(v) for v in inner_local], [], [tuple(f) for f in bp["faces"]])
        mi.materials.append(mat_inner)
        oi = bpy.data.objects.new(bp["innerName"], mi)
        oi.matrix_world = M_bpy
        col_inner.objects.link(oi)
        for k, v in bp["innerProps"].items():
            oi[k] = v
        oi["diagonal_midpoint_world"] = [c / MM for c in m]
        oi["xy_revision"] = "Rebuilt from design file by rebuild_design.py"
        add_presentation_modifiers(oi, canon["presentation"]["innerThicknessMm"], -1.0)

        # Check the stored (float32) result against the rule.
        mw = ob.matrix_world
        ow = [mw @ v.co for v in me.vertices]
        iw = [oi.matrix_world @ v.co for v in mi.vertices]
        mm_ = (ow[right] + ow[up]) / 2
        for a, b in zip(ow, iw):
            inner_err = max(inner_err, ((mm_ + INNER_SCALE * (a - mm_)) - b).length * MM)
        mid_err = max(mid_err, (((iw[right] + iw[up]) / 2) - mm_).length * MM)
        tip_err = max(tip_err, (ow[apex] * MM - Vector(tip)).length)

    # Board at the design's saved size.
    b = design["board"]
    bw, bh, bt = b["width"] / MM, b["height"] / MM, b["thickness"] / MM
    verts = [(sx * bw / 2, sy * bh / 2, sz * bt / 2) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    bm = bpy.data.meshes.new("Backing board")
    bm.from_pydata(verts, [], faces)
    bm.materials.append(mat_board)
    board = bpy.data.objects.new("Backing board - matte black - 2 inch border" if not colors else "Backing board - 2 inch border", bm)
    board.location = (b["centerX"] / MM, b["centerY"] / MM, (b["topZ"] - b["thickness"] / 2) / MM)
    bev = board.modifiers.new("Slightly softened board edge", "BEVEL")
    bev.width = 0.0006
    bev.segments = 3
    bev.limit_method = "ANGLE"
    board["board_border_mm"] = b.get("border", 50.8)
    board["board_origin"] = b.get("origin", "imported")
    col_studio.objects.link(board)

    if not args.no_studio:
        build_studio(scene, col_studio, pres)

    scene["design_name"] = design.get("name", "")
    scene["design_source_sha256"] = design.get("source", {}).get("sha256", "")
    scene["inner_scale"] = INNER_SCALE
    scene["inner_alignment"] = "Scale all vertices about midpoint of base hypotenuse."
    scene["rebuilt_by"] = "rebuild_design.py (Origami Waves)"

    report = {
        "design": design.get("name"),
        "pieces": len(pieces),
        "editedTips": edited,
        "tipMaxErrorMm": tip_err,
        "innerRuleMaxErrorMm": inner_err,
        "diagonalMidpointMaxErrorMm": mid_err,
        "boardMm": [b["width"], b["height"], b["thickness"]],
        "materials": {
            role: {
                "name": m.name,
                "rampUpperLinear": list(ramp_upper(m)),
            }
            for role, m in (("outer", mat_outer), ("inner", mat_inner), ("board", mat_board))
        },
        "out": os.path.abspath(args.out),
    }
    if args.compare:
        report["compare"] = compare_with(args.compare, pieces, by_id)

    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
    print("REBUILD_REPORT " + json.dumps(report))


def build_studio(scene, col, pres):
    bd = pres["materials"].get("backdrop") or {}
    color = (bd.get("principled", {}).get("Base Color") or [0.26, 0.28, 0.30])[:3]
    backdrop_mat = plain_material("Warm neutral studio surface", color, 0.91)
    me = bpy.data.meshes.new("Studio backdrop")
    s = 100.0
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(backdrop_mat)
    ob = bpy.data.objects.new("Studio backdrop", me)
    cx, cy = pres["board"]["center"]
    ob.location = (cx / MM, cy / MM, (pres.get("backdropZMm") or -6.8) / MM)
    col.objects.link(ob)

    for L in pres["lights"]:
        light = bpy.data.lights.new(L["name"], "AREA")
        light.shape = L.get("shape") or "DISK"
        light.size = L["sizeMm"] / MM
        light.energy = L["energyW"]
        light.color = L["color"]
        ob = bpy.data.objects.new(L["name"], light)
        ob.location = [c / MM for c in L["positionMm"]]
        ob.rotation_euler = Vector(L["direction"]).to_track_quat("-Z", "Y").to_euler()
        col.objects.link(ob)

    for C in pres["cameras"]:
        cam = bpy.data.cameras.new(C["name"])
        cam.type = C.get("type", "ORTHO")
        cam.ortho_scale = C["orthoScaleMm"] / MM
        cam.clip_start, cam.clip_end = 0.1, 1000.0
        ob = bpy.data.objects.new(C["name"], cam)
        ob.location = [c / MM for c in C["positionMm"]]
        fwd, up = Vector(C["forward"]), Vector(C["up"])
        right = fwd.cross(up).normalized()
        rot = Matrix((right, up.normalized(), -fwd.normalized())).transposed()
        ob.rotation_euler = rot.to_euler()
        col.objects.link(ob)
        if C["name"].startswith("01") and scene.camera is None:
            scene.camera = ob

    world = bpy.data.worlds.new("Soft studio environment")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    w = pres.get("world") or {"color": [0.72, 0.79, 0.91], "strength": 0.25}
    bg.inputs["Color"].default_value = (*w["color"], 1.0)
    bg.inputs["Strength"].default_value = w["strength"]
    scene.world = world


def compare_with(path, pieces, by_id):
    """Compare rebuilt shell vertices (world, mm) with the same-named objects of another .blend."""
    wanted = []
    for p in pieces:
        bp = by_id[p["id"]]
        wanted += [(p, "outer", bp["outerName"]), (p, "inner", bp["innerName"])]
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        available = set(src.objects)
        requested = [w for w in wanted if w[2] in available]
        dst.objects = [w[2] for w in requested]
    max_outer = max_inner = max_base = 0.0
    compared = 0
    for (p, role, name), ref in zip(requested, dst.objects):
        mine = bpy.data.objects.get(name)
        if ref is None or mine is None:
            continue
        compared += 1
        for k, (a, b) in enumerate(zip(mine.data.vertices, ref.data.vertices)):
            d = ((mine.matrix_basis @ a.co) - (ref.matrix_basis @ b.co)).length * MM  # no parents: basis == world
            if role == "outer":
                max_outer = max(max_outer, d)
                if k != p["apex"]:
                    max_base = max(max_base, d)
            else:
                max_inner = max(max_inner, d)
    # Remove the reference copies so they are not written into the output file.
    for ref in dst.objects:
        if ref is not None:
            mesh = ref.data
            bpy.data.objects.remove(ref)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
    return {"file": os.path.abspath(path), "comparedObjects": compared, "outerMaxDiffMm": max_outer,
            "innerMaxDiffMm": max_inner, "baseMaxDiffMm": max_base}


main()
