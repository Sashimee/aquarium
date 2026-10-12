# Asset catalog

Curated for T05 (#5), checked 2026-10-12. Ranks are by fit for a photorealistic tank. Renders are the Sketchfab-hosted preview thumbnails (linked, not committed).

## Status and caveats

- Sketchfab downloads need an authenticated API token, which this environment does not have. Every Sketchfab asset below is **selected but not downloaded** (`status: selected-pending-download`, `sha256: null` in the manifest). Licence, author, face count and downloadable flag were verified from the model record (Sketchfab API `/v3/models/<uid>`, the same data the page shows). To finish: put a Sketchfab token at `~/.config/aquarium/sketchfab.token` (mode 600), download each into `~/.cache/aquarium-assets/raw/<asset-id>/`, and fill `sha256`.
- Poly Haven and Wikimedia assets are downloaded and hashed; Poly Haven md5 values were verified against the API.
- Smithsonian 3D (3d.si.edu) blocks non-browser access, so its CC0 corals are taken through the Smithsonian Sketchfab account.
- Polycounts are from Sketchfab metadata; textures and rig state must be confirmed after download.

## Fallback (procedural loft)

| Species | Reason | Reference photos |
|---|---|---|
| Blue tang, yellow tang | Sketchfab picks are weak; auditor decides | `wm-bluetang-244215093`, `wm-bluetang-holleday`, `wm-yellowtang-holleday` |
| Bronze corydoras | only candidate is inaccurate | `wm-cory-aeneus-ack210`, `wm-cory-aeneus-ark` |
| Royal gramma | no model exists | `wm-gramma-257593001`, `wm-gramma-365520074` |
| Banggai cardinalfish | only wrong-species models | `wm-banggai-53953454`, `wm-banggai-holleday` |
| Anemone (host) | no photoreal free model | procedural TSL |

## CC-BY-SA (not used, for Alex to decide)

Higher-quality reference photos exist only under CC BY-SA and were not used: Corydoras aeneus 01/02/03 (User:GABS, 4.0), Gramma loreto 01 (User:Llez, 3.0), Pterapogon kauderni 8zz/9zz (David J. Stang, 4.0). No CC-BY-SA 3D models were selected.

## Species candidates

### Neon tetra (Paracheirodon innesi)

**Decision: pick `sketchfab-2fabf5db`**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Paracheirodon Innesi _ Tetra Neon](https://sketchfab.com/3d-models/2fabf5db754746b7b81ebfa0bbe99161) ([render](https://media.sketchfab.com/models/2fabf5db754746b7b81ebfa0bbe99161/thumbnails/018bb02e7c134c24ac1d9936f273de1e/d6ff001914b548f19c03b94a0b2f0d9d.jpeg)) | BlueMesh | CC-BY 4.0 | 1,498 | good, correct blue and red stripes | good | PICK |
| 2 | [neon tetra](https://sketchfab.com/3d-models/e6f877136a874a7d9124846d095915dc) ([render](https://media.sketchfab.com/models/e6f877136a874a7d9124846d095915dc/thumbnails/2b5ddcb0d1374168a958463f2f2d8ad0/9426422de40e474b95a64103bf2afb10.jpeg)) | oscargao2004 | CC-BY 4.0 | 732 | flat colours | crude, not fish-shaped | reject |

### Angelfish (Pterophyllum scalare)

**Decision: pick `sketchfab-e03ff546`**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Low poly Angel Fish](https://sketchfab.com/3d-models/e03ff546c39b441b993048a3787952fb) ([render](https://media.sketchfab.com/models/e03ff546c39b441b993048a3787952fb/thumbnails/71a387ded3204c88b77d2ad8f6211150/d13112702cfc458d95bdd007f3578b7f.jpeg)) | Sarath K | CC-BY 4.0 | 3,104 | hand-painted marbled, 4 colourways | good silhouette, filaments | PICK |
| 2 | [SIT253 Angelfish](https://sketchfab.com/3d-models/5726e45c8a8d4dc2ad9f6165f4d522f4) ([render](https://media.sketchfab.com/models/5726e45c8a8d4dc2ad9f6165f4d522f4/thumbnails/a2a4d92df9024b6f9896bb234c6d6c42/e3a06b632dbc4d488dc1f15c8e7c547c.jpeg)) | sipsen | CC-BY 4.0 | 1,508 | flat shaded | marine angelfish, wrong species | reject |
| 3 | [Angelfish](https://sketchfab.com/3d-models/8191be1e978e43719943231d57546aa5) ([render](https://media.sketchfab.com/models/8191be1e978e43719943231d57546aa5/thumbnails/de0cbbb9bfb64505b62861de401dc95e/0bbb71fe93234523833147280dda6f0d.jpeg)) | NormanH | CC-BY 4.0 | 9,120 | glossy gold/blue | marine angelfish, wrong species | reject |

Only one usable freshwater angelfish exists on Sketchfab under an allowed licence. Fallback if the auditor rejects it: procedural loft using `wm-angelfish-a742578` (CC BY 4.0, Rjcastillo; in manifest).

### Bronze corydoras (Corydoras aeneus)

**Decision: fallback: procedural loft**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Bronze Corydora](https://sketchfab.com/3d-models/80db835f3bb7420aae1763c4f52122e8) ([render](https://media.sketchfab.com/models/80db835f3bb7420aae1763c4f52122e8/thumbnails/86eb9683c992438c9091264a3bc8078b/3013004618de4400907ef31b8213322f.jpeg)) | Something fishy | CC-BY 4.0 | 45,920 | blotchy | blobby body, oversized barbels, wrong fins | reject: accuracy |

Reference photos for the texture projection (in manifest, downloaded): `wm-cory-aeneus-ack210` (CC0, Andrew Keller, lateral view) and `wm-cory-aeneus-ark` (CC BY 3.0, Ark pl wiki).

### Betta (Betta splendens)

**Decision: pick `sketchfab-f4eeb7f5`**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Betta Splendens](https://sketchfab.com/3d-models/f4eeb7f50ad24873842bd954ad27d23b) ([render](https://media.sketchfab.com/models/f4eeb7f50ad24873842bd954ad27d23b/thumbnails/1002b40a46fa410da07ff80932c9cbe2/87d61156567f4c5f97204860827f41c4.jpeg)) | BlueMesh | CC-BY 4.0 | 10,668 | excellent, fin rays and scales, 1 animation | good (halfmoon male) | PICK |
| 2 | [Betta fish](https://sketchfab.com/3d-models/01d48e9dc5f84caf9a604f28623564a6) ([render](https://media.sketchfab.com/models/01d48e9dc5f84caf9a604f28623564a6/thumbnails/6ab74860710043f48827f20089bd264e/724b729ecdbe471d9e5ef372dc3008da.jpeg)) | polyplant3d | CC-BY 4.0 | 2,552 | photo-based | good, rosetail | alternate colourway |
| 3 | [Wild Betta Fish (Betta splendens)](https://sketchfab.com/3d-models/e3cbbc2484be4764abb129bb9cc8002b) ([render](https://media.sketchfab.com/models/e3cbbc2484be4764abb129bb9cc8002b/thumbnails/4bdeac63bf6a45548bf55ac3a70dccc4/56f9feca267a4b7fafd093ed4de3bf1d.jpeg)) | Maruk | CC-BY 4.0 | 2,756 | decent | short-finned wild type | alternate / female |

### Guppy (Poecilia reticulata)

**Decision: pick `sketchfab-21e14e4b` (male) and `sketchfab-feab250d` (female)**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Guppy Fish](https://sketchfab.com/3d-models/21e14e4b961e406385539f79eacdb1dc) ([render](https://media.sketchfab.com/models/21e14e4b961e406385539f79eacdb1dc/thumbnails/2110c9f051464e83b6dcb7b669937e85/70eac3101452467dba7993a3080d43a0.jpeg)) | BlueMesh | CC-BY 4.0 | 1,689 | very good, speckled blue male | good | PICK (male) |
| 2 | [Guppy (female)](https://sketchfab.com/3d-models/feab250d4ab544de8eb7fda9fc1c2978) ([render](https://media.sketchfab.com/models/feab250d4ab544de8eb7fda9fc1c2978/thumbnails/def9b1ab653b4df6be38289b78245d12/981ce6dc59104ab3857e38a075f431e2.jpeg)) | Nestaeric | CC-BY 4.0 | 6,548 | good, 2 animations | good | PICK (female) |
| 3 | [Green Guppy Male](https://sketchfab.com/3d-models/86c037b070384048a8c1d59217ec046c) ([render](https://media.sketchfab.com/models/86c037b070384048a8c1d59217ec046c/thumbnails/5aaba0586e3346d8aa56f58d4799d9fe/ff23e067ae564df799db868df892bbe5.jpeg)) | Nullified | CC-BY 4.0 | 4,774 | good, green cobra | good | spare colourway |

### Ocellaris clownfish (Amphiprion ocellaris)

**Decision: pick `sketchfab-47ba2679`**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Clownfish](https://sketchfab.com/3d-models/47ba2679d91a4f14b3fc0bf8e3805af5) ([render](https://media.sketchfab.com/models/47ba2679d91a4f14b3fc0bf8e3805af5/thumbnails/55994c689788473abb716305c55f6347/1b46954b8aaf48ac816f68cef30fdf74.jpeg)) | zixisun02 | CC-BY 4.0 | 1,606 | good PBR, black fin edging | good | PICK |
| 2 | [Clownfish](https://sketchfab.com/3d-models/e6db2c191bf346398087ba27de9b8a0a) ([render](https://media.sketchfab.com/models/e6db2c191bf346398087ba27de9b8a0a/thumbnails/94be1dedb52c413f81b07043abebe56a/315986477593451eb55b53b59d29c4cb.jpeg)) | kenchoo | CC-BY 4.0 | 1,605 | good, 1 animation, near-identical mesh | good | backup |
| 3 | [Fish Pet 1 - Ocellaris clownfish Cubius](https://sketchfab.com/3d-models/30b46c26b48c4359a7aa30dde185e4fb) ([render](https://media.sketchfab.com/models/30b46c26b48c4359a7aa30dde185e4fb/thumbnails/d7c817a8ad374cb191f7c9f0a22a27cf/d27d21514a22487fb8890f53082caf49.jpeg)) | POLYTRICITY | CC-BY 4.0 | 3,362 | stylised | cube-shaped cartoon | reject |

Anemone host: no photoreal anemone with a free licence was found, so the **anemone is a procedural TSL build** (tentacle sway). Stylised reference only: `Anemone` by Damco (CC-BY, 1,258 faces, animated).

### Blue tang (Paracanthurus hepatus)

**Decision: Sketchfab pick `sketchfab-00dac50e` kept as candidate; fallback: procedural loft recorded, visual auditor decides**

The reviewer found the pick weak: deep disc body, palette marking drawn as stripes, undersized caudal. Fallback references (in manifest, downloaded): `wm-bluetang-244215093` (CC0, Jean-Paul Boerekamps) and `wm-bluetang-holleday` (CC BY 3.0, Holger Krisp).

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Pacific Blue Tang](https://sketchfab.com/3d-models/00dac50ee5a745e9ae157df6a6a6068e) ([render](https://media.sketchfab.com/models/00dac50ee5a745e9ae157df6a6a6068e/thumbnails/f3f9491401c142b99e71267b09d88807/8ce02add18434bc1b115c41e357b31b3.jpeg)) | djmacaulay | CC-BY 4.0 | 3,688 | painted, flat, stray red marks on the pectoral | pattern and outline correct | PICK |
| 2 | [Blue Tang Low Res](https://sketchfab.com/3d-models/9a0e0fbb6e304e22b147adac4ede6cf9) ([render](https://media.sketchfab.com/models/9a0e0fbb6e304e22b147adac4ede6cf9/thumbnails/93e17be590f3488f8deaed23514b4106/786e32b808094be2bf3c611f62518fe9.jpeg)) | Erik | CC-BY 4.0 | 904 | simple, soft | body too round, fins crude | backup |
| 3 | [BlueTang](https://sketchfab.com/3d-models/d06263fcde564bbc90af26a914d18b44) ([render](https://media.sketchfab.com/models/d06263fcde564bbc90af26a914d18b44/thumbnails/cfe254e05c0641378c48d783ac7d226c/42667ed04589430298d4f169d73ed0db.jpeg)) | bronze82 | CC-BY 4.0 | 51,136 | unverified: only a top-down render was checked | unverified | too dense, unverified |

### Yellow tang (Zebrasoma flavescens)

**Decision: Sketchfab pick `sketchfab-5750f70a` kept as candidate; fallback: procedural loft recorded, visual auditor decides**

The reviewer found the pick weak: small tail and cartoon eye. Fallback reference (in manifest, downloaded): `wm-yellowtang-holleday` (CC BY 3.0, Holger Krisp); the other Commons yellow tang photos are CC BY-SA.

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Oxidane - Yellow Tang](https://sketchfab.com/3d-models/5750f70ac6734728b0eb3ed81de9bb2d) ([render](https://media.sketchfab.com/models/5750f70ac6734728b0eb3ed81de9bb2d/thumbnails/7ad7f0e2307b4aeb9dda1fd23d11915b/d6152d4df679460e8b46809b671ea578.jpeg)) | JayNme | CC-BY 4.0 | 1,184 | good painted skin | slightly stout, convincing snout | PICK |
| 2 | [Yellow Tang](https://sketchfab.com/3d-models/9c25121d214a4746b9b51df85e329a51) ([render](https://media.sketchfab.com/models/9c25121d214a4746b9b51df85e329a51/thumbnails/ae6e0a2454ff4aadad9db10689fae1fe/640x360.jpeg)) | arwenrivendell | CC-BY 4.0 | 565,248 | untextured sculpt | unverified | needs retopo and texture, reject |
| 3 | [Fishes Little Tang Yellow 1 Base](https://sketchfab.com/3d-models/fe8e3c931f6e4b569d1bf7e35f9227a5) ([render](https://media.sketchfab.com/models/fe8e3c931f6e4b569d1bf7e35f9227a5/thumbnails/16f6125961de4049a5ad1705bbdf0cfb/6fba8e18f6334de5a1255a5579d08ac9.jpeg)) | mohammad ebrahim | CC-BY 4.0 | 206,652 | cartoon | cartoony | reject |

### Royal gramma (Gramma loreto)

**Decision: fallback: procedural loft**


No Sketchfab model with an allowed licence exists (searches `gramma`, `Gramma loreto`, `royal gramma` returned nothing relevant).

Reference photos (in manifest, downloaded): `wm-gramma-257593001` (CC BY 4.0, Dan Schofield) and `wm-gramma-365520074` (CC BY 4.0, cello caruso-turiello). Key traits for the loft: purple front half, yellow rear half, black dorsal spot, long pelvic fins.

### Banggai cardinalfish (Pterapogon kauderni)

**Decision: fallback: procedural loft**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Cardinalfish](https://sketchfab.com/3d-models/b5fa632cca7b4400a61f4b5183cc1d41) ([render](https://media.sketchfab.com/models/b5fa632cca7b4400a61f4b5183cc1d41/thumbnails/384b9df09f6440559d4c0fd143776e27/b120e026ad144fd880e993f441ee6276.jpeg)) | viettextures | CC-BY 4.0 | 43,072 | good | a yellow-striped cardinalfish, wrong species | reject: species |
| 2 | [Amboina Cardinalfish (CC0 scan)](https://sketchfab.com/3d-models/3d8aa2c1f7674c84bf0758e17409abcd) ([render](https://media.sketchfab.com/models/3d8aa2c1f7674c84bf0758e17409abcd/thumbnails/117f9b70cc0d4a278a224baef3c397f2/242ef43981404775a8648f6956b4d948.jpeg)) | ffish.asia / floraZia.com | CC0 | 216,246 | specimen photogrammetry, dull | real anatomy, wrong species | body-shape reference only, not in manifest |

Reference photos (in manifest, downloaded): `wm-banggai-53953454` (CC BY 4.0, Dan Schofield, watermark in corner, crop it) and `wm-banggai-holleday` (CC BY 3.0, Holger Krisp). Key traits: tall first dorsal and long anal fin, deeply forked tail, three black bars, white spots.

## Environment assets

| Role | Asset | Author | Licence | Faces | Notes |
|---|---|---|---|---|---|
| Plants | [Aquariumplants (Java Fern, Vallisneria etc)](https://sketchfab.com/3d-models/f34fac656a364f8eaeab0918179d6df6) ([render](https://media.sketchfab.com/models/f34fac656a364f8eaeab0918179d6df6/thumbnails/d526331749ca4e16b2e9f7dc0da248f7/cea607bc09354350b90e3c6e3edbc04a.jpeg)) | Nullified | CC-BY 4.0 | 130,862 | split per plant and decimate; picked |
| Plants | [Pond Weed](https://sketchfab.com/3d-models/b34ed521c5bb45ca9191b6213e1830d6) ([render](https://media.sketchfab.com/models/b34ed521c5bb45ca9191b6213e1830d6/thumbnails/b6441940c5b44fce84e08434d8695268/1e2fa5b9038445b8807adae30cb66333.jpeg)) | Valery.Li | CC-BY 4.0 | 7,549 | stem plant; picked |
| Plants | [Water plant](https://sketchfab.com/3d-models/b536fec3648f485087c8dd280e749502) ([render](https://media.sketchfab.com/models/b536fec3648f485087c8dd280e749502/thumbnails/42d4291e40874e7abf43c7e5a0536318/9653234729014971a6985a86e143f722.jpeg)) | Nataly | CC-BY 4.0 | 6,076 | Egeria-like stem; picked |
| Driftwood | [Real Aquarium Wood 3D scan](https://sketchfab.com/3d-models/c53807eff7c4427faacfde6c1b581532) ([render](https://media.sketchfab.com/models/c53807eff7c4427faacfde6c1b581532/thumbnails/63107294e53b4ef3b3ffef05669487cb/eb987f75d8484cfd962fbc5f8df9a702.jpeg)) | grafi | CC-BY 4.0 | 40,000 | best driftwood; picked |
| Driftwood | Poly Haven `dead_quiver_trunk`, `dead_tree_trunk_02` | Poly Haven artists | CC0 | 17,978 / 83,128 | extras, downloaded |
| Rock | Poly Haven `boulder_01` | Rico Cilliers | CC0 | 66,122 | freshwater rockwork, downloaded |
| Reef rock | Poly Haven `coast_rocks_05` | Rob Tuytel | CC0 | 771,724 | live-rock stand-in, heavy: decimate hard |
| Coral | [Acropora palmata](https://sketchfab.com/3d-models/8cb986313c824ac38c373c0fabd0805f) ([render](https://media.sketchfab.com/models/8cb986313c824ac38c373c0fabd0805f/thumbnails/c598950f02544027bfee0f82ae8bc658/9497147db83b4e629edb592473d10591.jpeg)) | Smithsonian | CC0 | 100,000 | bleached skeleton, needs tint |
| Coral | [Brain Coral (platygyra)](https://sketchfab.com/3d-models/4ea44ce7563b4407a630e3cc65187a90) ([render](https://media.sketchfab.com/models/4ea44ce7563b4407a630e3cc65187a90/thumbnails/ba7192ba9cf54f6b8d0659692ba69467/80b3b4fe7cef468f933b92f466d810b5.jpeg)) | QQman | CC-BY 4.0 | 40,002 | photoreal |
| Coral | [Blue Sea Anemone L (reef piece)](https://sketchfab.com/3d-models/f2542a8681584d048e515c660e6866fe) ([render](https://media.sketchfab.com/models/f2542a8681584d048e515c660e6866fe/thumbnails/9cd178a4da3644ac9d424508cbc281cd/2448df9406a24ff2b1c5ed63103ee865.jpeg)) | stefanorivera | CC-BY 4.0 | 22,057 | focal reef piece; despite the title it is a coral on live rock |
| Decor | Poly Haven `lambis_shell` | Kuutti Siitonen | CC0 | 12,498 | reef decor, downloaded |
| Substrate | Poly Haven `coast_sand_01`, `clean_pebbles`, `coast_sand_04` | Poly Haven artists | CC0 | n/a | freshwater sand, gravel, reef sand (2k PBR), downloaded |
| HDRI | Poly Haven `kloofendal_48d_partly_cloudy_puresky`, `studio_small_09` | Greg Zaal, Jarod Guest / Sergej Majboroda | CC0 | n/a | 2k .hdr, downloaded |

Poly Haven licence verified on the asset page (https://polyhaven.com/a/boulder_01 shows CC0) and https://polyhaven.com/license.
