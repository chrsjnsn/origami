"""
Asset preparation for the Origami 1829 browser studio.

Reads origami1829-final-vision.blend (never saves it) and writes:

  public/assets/sculpture.json         canonical per-piece geometry (mm, board coordinates)
  public/assets/presentation.json      materials, lights, cameras, board, render look
  public/assets/sculpture-blender.json raw Blender-local data for exact reconstruction
  public/assets/textures/paper-grain.png baked, tileable paper grain (albedo factor, also used as bump)
  assets-src/prep-report.json          verification of the import

Usage (from the project root):

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      assets-src/origami1829-final-vision.blend \
      --python-exit-code 1 -P tools/blender/export_canonical.py -- --root .

Board coordinates: X right, Y up, Z outward toward the viewer; the mounting plane is z = 0.
Blender world coordinates already use this convention, so no axis swap is applied.
"""

import argparse
import hashlib
import json
import math
import os
import statistics
import struct
import sys
import zlib

import bpy
import numpy as np
from mathutils import Matrix, Vector

MM = 1000.0
GRID_COLS = 29
GRID_ROWS = 18
SPACING_MM = 50.0
INNER_SCALE = 0.75


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--root", default=".")
    return p.parse_args(argv)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mat_to_list(m):
    return [[float(m[r][c]) for c in range(4)] for r in range(4)]


def world_mm(matrix_rows, co):
    """Apply a 4x4 object matrix in double precision and convert meters to millimeters."""
    x, y, z = (float(co[0]), float(co[1]), float(co[2]))
    out = []
    for r in range(3):
        row = matrix_rows[r]
        out.append((row[0] * x + row[1] * y + row[2] * z + row[3]) * MM)
    return out


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def scale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def dist(a, b):
    d = sub(a, b)
    return math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)


def write_png(path, width, height, rows, channels):
    """Minimal deterministic PNG writer (8-bit, grayscale or RGB)."""
    color_type = {1: 0, 3: 2, 4: 6}[channels]
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def principled_inputs(node):
    wanted = ["Base Color", "Metallic", "Roughness", "IOR", "Specular IOR Level", "Coat Weight", "Sheen Weight"]
    out = {}
    for name in wanted:
        sock = node.inputs.get(name)
        if sock is None or not hasattr(sock, "default_value"):
            continue
        v = sock.default_value
        out[name] = [float(x) for x in v] if hasattr(v, "__len__") else float(v)
    return out


def describe_material(mat):
    info = {"name": mat.name}
    nodes = mat.node_tree.nodes if mat.node_tree else []
    for n in nodes:
        if n.bl_idname == "ShaderNodeBsdfPrincipled":
            info["principled"] = principled_inputs(n)
        elif n.bl_idname == "ShaderNodeTexNoise":
            info["noise"] = {
                "type": n.noise_type,
                "dimensions": n.noise_dimensions,
                "scale_per_m": float(n.inputs["Scale"].default_value),
                "detail": float(n.inputs["Detail"].default_value),
                "roughness": float(n.inputs["Roughness"].default_value),
                "lacunarity": float(n.inputs["Lacunarity"].default_value),
            }
        elif n.bl_idname == "ShaderNodeBump":
            info["bump"] = {
                "strength": float(n.inputs["Strength"].default_value),
                "distance_m": float(n.inputs["Distance"].default_value),
            }
        elif n.bl_idname == "ShaderNodeValToRGB":
            info["ramp"] = [
                {"position": float(e.position), "linear_rgb": [float(c) for c in e.color[:3]]}
                for e in n.color_ramp.elements
            ]
    return info


def describe_modifiers(obj):
    mods = []
    for m in obj.modifiers:
        d = {"name": m.name, "type": m.type}
        if m.type == "SOLIDIFY":
            d.update(thickness_mm=m.thickness * MM, offset=m.offset, use_even_offset=m.use_even_offset,
                     use_rim=m.use_rim, solidify_mode=m.solidify_mode,
                     nonmanifold_thickness_mode=m.nonmanifold_thickness_mode,
                     use_quality_normals=m.use_quality_normals)
        elif m.type == "BEVEL":
            d.update(width_mm=m.width * MM, segments=m.segments, limit_method=m.limit_method,
                     angle_limit_rad=m.angle_limit, offset_type=m.offset_type, profile=m.profile,
                     use_clamp_overlap=m.use_clamp_overlap)
        mods.append(d)
    return mods


def evaluated_bounds_mm(obj, depsgraph):
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    mw = ev.matrix_world
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for v in me.vertices:
        w = mw @ v.co
        for i in range(3):
            lo[i] = min(lo[i], w[i] * MM)
            hi[i] = max(hi[i], w[i] * MM)
    ev.to_mesh_clear()
    return lo, hi


def classify_piece(verts_mm):
    """Return corner, right, up and apex indices for one outer shell."""
    base = [i for i, v in enumerate(verts_mm) if abs(v[2]) < 1e-3]
    apex = [i for i in range(4) if i not in base]
    if len(base) != 3 or len(apex) != 1:
        raise RuntimeError("Expected three base vertices on z=0 and one apex: %r" % (verts_mm,))
    xs = [verts_mm[i][0] for i in base]
    ys = [verts_mm[i][1] for i in base]
    min_x, min_y = min(xs), min(ys)
    corner = [i for i in base if abs(verts_mm[i][0] - min_x) < 1e-3 and abs(verts_mm[i][1] - min_y) < 1e-3]
    if len(corner) != 1:
        raise RuntimeError("No unique right-angle corner")
    corner = corner[0]
    others = [i for i in base if i != corner]
    right = max(others, key=lambda i: verts_mm[i][0])
    up = [i for i in others if i != right][0]
    return corner, right, up, apex[0]


def bake_grain(tex_dir, seed=1829, size=512, mm_per_px=0.04, lattice_mm=0.2083):
    """Tileable fBm grain approximating the Blender noise (scale 4800 / m, detail 2.5, roughness 0.72)."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((size, size))
    spectrum = np.fft.fft2(white)
    fx = np.fft.fftfreq(size)[None, :]
    fy = np.fft.fftfreq(size)[:, None]
    f = np.sqrt(fx * fx + fy * fy)  # cycles per pixel
    base_f = mm_per_px / (2.0 * lattice_mm)  # Perlin energy peaks near half the lattice frequency
    detail, rough = 2.5, 0.72
    weight = np.zeros_like(f)
    octave = 0
    amp = 1.0
    while octave <= math.ceil(detail):
        fo = base_f * (2.0 ** octave)
        w = amp if octave <= int(detail) else amp * (detail - int(detail))
        weight += w * np.exp(-((f - fo) ** 2) / (2 * (0.45 * fo) ** 2))
        amp *= rough
        octave += 1
    weight[0, 0] = 0.0
    height = np.real(np.fft.ifft2(spectrum * weight))
    height = (height - height.mean()) / height.std()

    # Albedo factor: Blender ramps run 0.17 -> 0.83 between two proportional colors (ratio ~0.632).
    fac = np.clip(0.5 + 0.12 * height, 0.0, 1.0)
    t = np.clip((fac - 0.17) / 0.66, 0.0, 1.0)
    albedo = 0.632 + 0.368 * t
    albedo8 = np.clip(np.round(albedo * 255.0), 0, 255).astype(np.uint8)
    write_png(os.path.join(tex_dir, "paper-grain.png"), size, size, [albedo8[r].tobytes() for r in range(size)], 1)

    return {
        "size_px": size,
        "tile_mm": size * mm_per_px,
        "mm_per_px": mm_per_px,
        "seed": seed,
        "albedo_factor_range": [float(albedo.min()), float(albedo.max())],
        "method": "Tileable FFT band-pass fBm approximating Blender FBM noise (scale 4800/m, detail 2.5, roughness 0.72); "
                  "albedo factor follows the 0.17-0.83 color ramp. The same texture drives the bump map in the browser.",
    }


def main():
    args = parse_args()
    root = os.path.abspath(args.root)
    blend_path = bpy.data.filepath
    hash_before = sha256(blend_path)

    out_dir = os.path.join(root, "public", "assets")
    tex_dir = os.path.join(out_dir, "textures")
    os.makedirs(tex_dir, exist_ok=True)

    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    outers = [o for o in bpy.data.objects if o.type == "MESH" and o.get("vision_role") == "outer"]
    inners = {o.name: o for o in bpy.data.objects if o.type == "MESH" and o.get("vision_role") == "inner"}
    board_obj = next(o for o in bpy.data.objects if o.name.startswith("Backing board"))
    backdrop = bpy.data.objects.get("Studio backdrop")

    matrices = {tuple(tuple(round(x, 12) for x in r) for r in mat_to_list(o.matrix_world)) for o in outers + list(inners.values())}
    if len(matrices) != 1:
        raise RuntimeError("Expected every shell to share one object matrix, found %d" % len(matrices))
    shell_matrix = mat_to_list(outers[0].matrix_world)

    pieces = []
    blender_pieces = []
    report_pieces = []
    inner_err_max = 0.0
    midpoint_err_max = 0.0
    collinear_err_max = 0.0
    face_orders = {}
    env_lo = [math.inf] * 3
    env_hi = [-math.inf] * 3
    env_in_lo = [math.inf] * 3
    env_in_hi = [-math.inf] * 3
    design_lo = [math.inf] * 3
    design_hi = [-math.inf] * 3

    for o in outers:
        pid = o["wave_piece_id"]
        inner = inners[o["paired_inner"]]
        me = o.data
        if len(me.vertices) != 4 or len(me.polygons) != 3:
            raise RuntimeError("%s: expected 4 vertices / 3 faces" % o.name)
        verts = [world_mm(shell_matrix, v.co) for v in me.vertices]
        faces = [list(p.vertices) for p in me.polygons]
        corner, right, up, apex = classify_piece(verts)
        col = int(round(verts[corner][0] / SPACING_MM))
        row = int(round(verts[corner][1] / SPACING_MM))
        expected_id = "C%02d-R%02d" % (col + 1, row + 1)
        if expected_id != pid:
            raise RuntimeError("%s: id %s does not match grid position %s" % (o.name, pid, expected_id))
        edges_present = {tuple(sorted(e.vertices)) for e in me.edges}
        open_face = sorted([right, up, apex])
        face_sets = [sorted(f) for f in faces]
        if open_face in face_sets:
            raise RuntimeError("%s: hypotenuse face unexpectedly closed" % o.name)
        face_orders[json.dumps(faces)] = face_orders.get(json.dumps(faces), 0) + 1

        m = scale(add(verts[right], verts[up]), 0.5)
        inner_verts = [world_mm(shell_matrix, v.co) for v in inner.data.vertices]
        inner_faces = [list(p.vertices) for p in inner.data.polygons]
        if inner_faces != faces:
            raise RuntimeError("%s: inner topology differs from outer" % pid)
        for i in range(4):
            expected = add(m, scale(sub(verts[i], m), INNER_SCALE))
            inner_err_max = max(inner_err_max, dist(expected, inner_verts[i]))
        m_in = scale(add(inner_verts[right], inner_verts[up]), 0.5)
        midpoint_err_max = max(midpoint_err_max, dist(m, m_in))
        # Collinearity of the inner diagonal endpoints with the outer diagonal line.
        d = sub(verts[up], verts[right])
        dl = math.sqrt(sum(c * c for c in d))
        for idx in (right, up):
            w = sub(inner_verts[idx], verts[right])
            cross = [d[1] * w[2] - d[2] * w[1], d[2] * w[0] - d[0] * w[2], d[0] * w[1] - d[1] * w[0]]
            collinear_err_max = max(collinear_err_max, math.sqrt(sum(c * c for c in cross)) / dl)

        centroid = scale(add(add(verts[corner], verts[right]), verts[up]), 1.0 / 3.0)
        for v in verts:
            for i in range(3):
                design_lo[i] = min(design_lo[i], v[i])
                design_hi[i] = max(design_hi[i], v[i])
        lo, hi = evaluated_bounds_mm(o, depsgraph)
        ilo, ihi = evaluated_bounds_mm(inner, depsgraph)
        for i in range(3):
            env_lo[i] = min(env_lo[i], lo[i])
            env_hi[i] = max(env_hi[i], hi[i])
            env_in_lo[i] = min(env_in_lo[i], ilo[i])
            env_in_hi[i] = max(env_in_hi[i], ihi[i])

        pieces.append({
            "id": pid,
            "col": col,
            "row": row,
            "vertices": verts,
            "faces": faces,
            "corner": corner,
            "right": right,
            "up": up,
            "apex": apex,
            "diagonalMidpoint": m,
            "baseCentroid": [centroid[0], centroid[1], centroid[2]],
        })
        blender_pieces.append({
            "id": pid,
            "outerName": o.name,
            "outerMesh": me.name,
            "innerName": inner.name,
            "innerMesh": inner.data.name,
            "outerLocal": [[float(c) for c in v.co] for v in me.vertices],
            "innerLocal": [[float(c) for c in v.co] for v in inner.data.vertices],
            "faces": faces,
            "edges": sorted(list(e) for e in edges_present),
            "outerProps": {k: (o[k].to_list() if hasattr(o[k], "to_list") else o[k]) for k in o.keys()},
            "innerProps": {k: (inner[k].to_list() if hasattr(inner[k], "to_list") else inner[k]) for k in inner.keys()},
        })
        report_pieces.append({"id": pid, "outerEvaluatedBoundsMm": [lo, hi], "innerEvaluatedBoundsMm": [ilo, ihi]})

    pieces.sort(key=lambda p: (p["row"], p["col"]))
    blender_pieces.sort(key=lambda p: p["id"])
    report_pieces.sort(key=lambda p: p["id"])
    if len(pieces) != GRID_COLS * GRID_ROWS:
        raise RuntimeError("Expected %d pieces, got %d" % (GRID_COLS * GRID_ROWS, len(pieces)))
    seen = {(p["col"], p["row"]) for p in pieces}
    if len(seen) != len(pieces):
        raise RuntimeError("Duplicate grid cells")

    # Board: mesh vertices (pre-bevel) and evaluated bounds.
    bmw = mat_to_list(board_obj.matrix_world)
    bverts = [world_mm(bmw, v.co) for v in board_obj.data.vertices]
    blo = [min(v[i] for v in bverts) for i in range(3)]
    bhi = [max(v[i] for v in bverts) for i in range(3)]
    board_eval_lo, board_eval_hi = evaluated_bounds_mm(board_obj, depsgraph)
    board = {
        "widthMm": bhi[0] - blo[0],
        "heightMm": bhi[1] - blo[1],
        "thicknessMm": bhi[2] - blo[2],
        "center": [(blo[0] + bhi[0]) / 2, (blo[1] + bhi[1]) / 2],
        "topZMm": bhi[2],
        "boundsMm": [blo, bhi],
        "evaluatedBoundsMm": [board_eval_lo, board_eval_hi],
        "bevel": describe_modifiers(board_obj),
        "material": board_obj.data.materials[0].name,
    }
    border = {
        "left": env_lo[0] - blo[0],
        "right": bhi[0] - env_hi[0],
        "bottom": env_lo[1] - blo[1],
        "top": bhi[1] - env_hi[1],
    }

    heights = [p["vertices"][p["apex"]][2] for p in pieces]
    offsets = [sub(p["vertices"][p["apex"]], p["baseCentroid"]) for p in pieces]

    # Cameras and lights.
    cameras = []
    for cam in sorted((o for o in bpy.data.objects if o.type == "CAMERA"), key=lambda o: o.name):
        mw = cam.matrix_world
        q = mw.to_quaternion()
        fwd = q @ Vector((0, 0, -1))
        up = q @ Vector((0, 1, 0))
        loc = mw.translation
        t = -loc.z / fwd.z if abs(fwd.z) > 1e-9 else 0
        target = loc + fwd * t
        cameras.append({
            "name": cam.name,
            "type": cam.data.type,
            "orthoScaleMm": cam.data.ortho_scale * MM,
            "lensMm": cam.data.lens,
            "sensorWidthMm": cam.data.sensor_width,
            "positionMm": [loc.x * MM, loc.y * MM, loc.z * MM],
            "forward": [fwd.x, fwd.y, fwd.z],
            "up": [up.x, up.y, up.z],
            "targetOnBoardMm": [target.x * MM, target.y * MM, target.z * MM],
        })
    lights = []
    for L in sorted((o for o in bpy.data.objects if o.type == "LIGHT"), key=lambda o: o.name):
        mw = L.matrix_world
        q = mw.to_quaternion()
        fwd = q @ Vector((0, 0, -1))
        lights.append({
            "name": L.name,
            "type": L.data.type,
            "shape": getattr(L.data, "shape", None),
            "sizeMm": getattr(L.data, "size", 0.0) * MM,
            "energyW": L.data.energy,
            "color": [float(c) for c in L.data.color],
            "positionMm": [mw.translation.x * MM, mw.translation.y * MM, mw.translation.z * MM],
            "direction": [fwd.x, fwd.y, fwd.z],
        })

    world = scene.world
    world_info = None
    if world and world.node_tree:
        bg = next((n for n in world.node_tree.nodes if n.bl_idname == "ShaderNodeBackground"), None)
        if bg:
            world_info = {"color": [float(c) for c in bg.inputs["Color"].default_value[:3]],
                          "strength": float(bg.inputs["Strength"].default_value)}

    outer_mat = outers[0].data.materials[0]
    inner_mat = next(iter(inners.values())).data.materials[0]
    grain = bake_grain(tex_dir)

    sculpture = {
        "format": "origami1829-canonical",
        "version": 1,
        "source": {
            "file": os.path.basename(blend_path),
            "sha256": hash_before,
            "blender": bpy.app.version_string,
            "note": "Latest saved geometry of origami1829-final-vision.blend. World coordinates evaluated in double precision from the saved float32 data.",
        },
        "units": "mm",
        "coordinateSystem": "X right, Y up, Z outward toward the viewer. Mounting plane z = 0.",
        "grid": {"cols": GRID_COLS, "rows": GRID_ROWS, "spacingMm": SPACING_MM,
                 "extentMm": [GRID_COLS * SPACING_MM, GRID_ROWS * SPACING_MM]},
        "innerScale": INNER_SCALE,
        "innerRule": "inner_vertex = M + 0.75 * (outer_vertex - M), M = midpoint of the base diagonal (right, up)",
        "topology": {
            "verticesPerShell": 4,
            "facesPerShell": 3,
            "description": "Open triangular shell: right-triangle mounting base (corner, right, up) plus two side faces "
                           "meeting at the apex. The hypotenuse face (right, up, apex) is open.",
        },
        "presentation": {"outerThicknessMm": 0.45, "innerThicknessMm": 0.25, "boardThicknessMm": board["thicknessMm"],
                         "borderMm": 50.8},
        "board": {k: board[k] for k in ("widthMm", "heightMm", "thicknessMm", "center", "topZMm")},
        "evaluatedEnvelopeMm": {"outer": [env_lo, env_hi], "inner": [env_in_lo, env_in_hi], "design": [design_lo, design_hi]},
        "stats": {
            "tipHeightMm": {"min": min(heights), "max": max(heights), "median": statistics.median(heights),
                            "mean": statistics.fmean(heights)},
            "leanFromCentroidMm": {
                "x": [min(o[0] for o in offsets), max(o[0] for o in offsets)],
                "y": [min(o[1] for o in offsets), max(o[1] for o in offsets)],
            },
        },
        "pieces": pieces,
    }

    presentation = {
        "renderLook": {"viewTransform": scene.view_settings.view_transform, "exposure": scene.view_settings.exposure,
                       "engine": scene.render.engine},
        "materials": {
            "outer": describe_material(outer_mat),
            "inner": describe_material(inner_mat),
            "board": board["material"],
            "backdrop": describe_material(backdrop.data.materials[0]) if backdrop else None,
        },
        "modifiers": {"outer": describe_modifiers(outers[0]), "inner": describe_modifiers(next(iter(inners.values())))},
        "board": board,
        "backdropZMm": (backdrop.matrix_world.translation.z * MM) if backdrop else None,
        "world": world_info,
        "cameras": cameras,
        "lights": lights,
        "grainTexture": grain,
    }

    blender_data = {
        "format": "origami1829-blender-source",
        "version": 1,
        "sourceSha256": hash_before,
        "shellMatrixWorld": shell_matrix,
        "boardMatrixWorld": bmw,
        "boardLocalVertices": [[float(c) for c in v.co] for v in board_obj.data.vertices],
        "boardFaces": [list(p.vertices) for p in board_obj.data.polygons],
        "collections": [c.name for c in bpy.data.collections],
        "sceneProps": {k: scene[k] for k in scene.keys() if isinstance(scene[k], (str, int, float))},
        "pieces": blender_pieces,
    }

    def dump(path, data, indent=None):
        with open(path, "w") as f:
            json.dump(data, f, indent=indent, separators=(",", ":") if indent is None else None)

    dump(os.path.join(out_dir, "sculpture.json"), sculpture)
    dump(os.path.join(out_dir, "presentation.json"), presentation, indent=2)
    dump(os.path.join(out_dir, "sculpture-blender.json"), blender_data)

    hash_after = sha256(blend_path)
    report = {
        "blend": blend_path,
        "sha256Before": hash_before,
        "sha256After": hash_after,
        "sourceUnchanged": hash_before == hash_after,
        "pieces": len(pieces),
        "faceOrderVariants": face_orders,
        "innerRuleMaxErrorMm": inner_err_max,
        "diagonalMidpointMaxErrorMm": midpoint_err_max,
        "innerDiagonalCollinearityMaxMm": collinear_err_max,
        "board": board,
        "evaluatedOuterEnvelopeMm": [env_lo, env_hi],
        "borderFromEvaluatedEnvelopeMm": border,
        "tipHeightMm": sculpture["stats"]["tipHeightMm"],
        "perPiece": report_pieces,
    }
    os.makedirs(os.path.join(root, "assets-src"), exist_ok=True)
    dump(os.path.join(root, "assets-src", "prep-report.json"), report, indent=1)

    print("EXPORT OK pieces=%d innerErr=%.3g mm midErr=%.3g mm board=%.4f x %.4f mm border=%s unchanged=%s" % (
        len(pieces), inner_err_max, midpoint_err_max, board["widthMm"], board["heightMm"],
        {k: round(v, 5) for k, v in border.items()}, hash_before == hash_after))
    if hash_before != hash_after:
        raise RuntimeError("Source .blend changed during export")


main()
