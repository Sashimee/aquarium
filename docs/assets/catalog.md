# Asset catalog

Curated for T05 (#5), checked 2026-10-12. Ranks are by fit for a photorealistic tank. Renders are the Sketchfab-hosted preview thumbnails (linked, not committed).

## Status and caveats

- All Sketchfab assets are downloaded (glTF zip plus extracted files, own directory each) and hashed. Licence, author and downloadable flag were verified from the model record (Sketchfab API `/v3/models/<uid>`, the same data the page shows). Face counts, textures and rig state below were re-measured from the downloaded glTF.
- Poly Haven and Wikimedia assets are downloaded and hashed; Poly Haven md5 values were verified against the API.
- Smithsonian 3D (3d.si.edu) blocks non-browser access, so its CC0 corals are taken through the Smithsonian Sketchfab account.
- Manifest `sha256` for a Sketchfab asset is the aggregate over `files[]`; the zip sha256 is in `notes`.

## Fallback (procedural loft)

| Species | Reason | Reference photos |
|---|---|---|
| Blue tang, yellow tang | Sketchfab picks are weak; auditor decides | `wm-bluetang-244215093`, `wm-bluetang-holleday`, `wm-yellowtang-holleday` |
| Bronze corydoras | only candidate is inaccurate | `wm-cory-aeneus-ack210`, `wm-cory-aeneus-ark`, `wm-cory-aeneus-gabs-01`, `wm-cory-aeneus-gabs-03` (CC BY-SA) |
| Royal gramma | no model exists | `wm-gramma-257593001`, `wm-gramma-365520074`, `wm-gramma-loreto-llez` (CC BY-SA) |
| Banggai cardinalfish | only wrong-species models | `wm-banggai-53953454`, `wm-banggai-holleday`, `wm-banggai-stang-8zz`, `wm-banggai-stang-10zz` (CC BY-SA) |
| Harlequin rasbora | no model exists | `wm-rasbora-vassil`, `wm-rasbora-roy` |
| Six-line wrasse | no model exists | `wm-sixline-huffman` |
| Firefish | no model exists | `wm-firefish-karelj` |
| Cherry shrimp | only cooked-prawn models; shrimp are not fish | `wm-cherry-dagostino-1`, `wm-cherry-dagostino-2` (procedural shrimp) |
| Skunk cleaner shrimp | no model of the species | `wm-cleaner-huffman`, `wm-cleaner-caruso`, `wm-cleaner-schofield` (procedural shrimp) |
| Cleaner wrasse (T44) | no Labroides model exists | `wm-labroides-jens`, `wm-labroides-hylton` |
| Nerite snail (soft body only) | the scan is a shell without foot, head or tentacles | `wm-nerite-baldonado-2`, `wm-nerite-obsidian-05` (procedural body) |
| Electric yellow cichlid (T48) | no allowed model of the species | `wm-labidochromis-chmee2`, `wm-labidochromis-severni` |
| Golden mbuna, Melanochromis auratus (T48) | no allowed model of the species | `wm-melanochromis-5snake5-female`, `wm-melanochromis-5snake5-male`, `wm-melanochromis-lee-1` |
| Black calvus, Altolamprologus calvus (T48) | no allowed model of the species | `wm-altolamprologus-5snake5` |
| Fairy cichlid, Neolamprologus brichardi (T48) | no usable reference photo (gap) | none: the only candidate, `Neolamprologus brichardi femmina.jpg`, is described by its author as N. olivaceus |
| Anemone (host) | no photoreal free model | procedural TSL |

## CC-BY-SA (allowed for reference photos only)

Alex approved CC BY-SA for three reference-photo sets (issue #29), used only as fallback references for the procedural loft species: Corydoras aeneus (`wm-cory-aeneus-gabs-01`, `-03`; Gabriel Resende Veiga, CC BY-SA 4.0), Gramma loreto (`wm-gramma-loreto-llez`; H. Zell, CC BY-SA 3.0) and Pterapogon kauderni (`wm-banggai-stang-8zz`, `-10zz`; David J. Stang, CC BY-SA 4.0). ShareAlike applies to any texture derived from them, so the pipeline must keep such textures separately attributed and under the same licence; the CC0 and CC-BY references remain the safer first choice. Full attribution is in `CREDITS.md`. No CC-BY-SA 3D models were selected, and other CC-BY-SA photos (for example further Commons yellow tang shots) remain unused.

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
| 1 | [Low poly Angel Fish](https://sketchfab.com/3d-models/e03ff546c39b441b993048a3787952fb) ([render](https://media.sketchfab.com/models/e03ff546c39b441b993048a3787952fb/thumbnails/71a387ded3204c88b77d2ad8f6211150/d13112702cfc458d95bdd007f3578b7f.jpeg)) | Sarath K | CC-BY 4.0 | 3,088 | hand-painted marbled, four colourways in one file, unlit materials | good silhouette, filaments | PICK |
| 2 | [SIT253 Angelfish](https://sketchfab.com/3d-models/5726e45c8a8d4dc2ad9f6165f4d522f4) ([render](https://media.sketchfab.com/models/5726e45c8a8d4dc2ad9f6165f4d522f4/thumbnails/a2a4d92df9024b6f9896bb234c6d6c42/e3a06b632dbc4d488dc1f15c8e7c547c.jpeg)) | sipsen | CC-BY 4.0 | 1,508 | flat shaded | marine angelfish, wrong species | reject |
| 3 | [Angelfish](https://sketchfab.com/3d-models/8191be1e978e43719943231d57546aa5) ([render](https://media.sketchfab.com/models/8191be1e978e43719943231d57546aa5/thumbnails/de0cbbb9bfb64505b62861de401dc95e/0bbb71fe93234523833147280dda6f0d.jpeg)) | NormanH | CC-BY 4.0 | 9,120 | glossy gold/blue | marine angelfish, wrong species | reject |

Only one usable freshwater angelfish exists on Sketchfab under an allowed licence. Fallback if the auditor rejects it: procedural loft using `wm-angelfish-a742578` (CC BY 4.0, Rjcastillo; in manifest).

### Bronze corydoras (Corydoras aeneus)

**Decision: fallback: procedural loft**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Bronze Corydora](https://sketchfab.com/3d-models/80db835f3bb7420aae1763c4f52122e8) ([render](https://media.sketchfab.com/models/80db835f3bb7420aae1763c4f52122e8/thumbnails/86eb9683c992438c9091264a3bc8078b/3013004618de4400907ef31b8213322f.jpeg)) | Something fishy | CC-BY 4.0 | 45,920 | blotchy | blobby body, oversized barbels, wrong fins | reject: accuracy |

Reference photos for the texture projection (in manifest, downloaded): `wm-cory-aeneus-ack210` (CC0, Andrew Keller, lateral view) and `wm-cory-aeneus-ark` (CC BY 3.0, Ark pl wiki). Higher-resolution CC BY-SA extras: `wm-cory-aeneus-gabs-01` (4231x2821) and `wm-cory-aeneus-gabs-03` (5184x3456).

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

Reference photos (in manifest, downloaded): `wm-gramma-257593001` (CC BY 4.0, Dan Schofield) and `wm-gramma-365520074` (CC BY 4.0, cello caruso-turiello); CC BY-SA extra `wm-gramma-loreto-llez` (H. Zell, 4400x3168). Key traits for the loft: purple front half, yellow rear half, black dorsal spot, long pelvic fins.

### Banggai cardinalfish (Pterapogon kauderni)

**Decision: fallback: procedural loft**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Cardinalfish](https://sketchfab.com/3d-models/b5fa632cca7b4400a61f4b5183cc1d41) ([render](https://media.sketchfab.com/models/b5fa632cca7b4400a61f4b5183cc1d41/thumbnails/384b9df09f6440559d4c0fd143776e27/b120e026ad144fd880e993f441ee6276.jpeg)) | viettextures | CC-BY 4.0 | 43,072 | good | a yellow-striped cardinalfish, wrong species | reject: species |
| 2 | [Amboina Cardinalfish (CC0 scan)](https://sketchfab.com/3d-models/3d8aa2c1f7674c84bf0758e17409abcd) ([render](https://media.sketchfab.com/models/3d8aa2c1f7674c84bf0758e17409abcd/thumbnails/117f9b70cc0d4a278a224baef3c397f2/242ef43981404775a8648f6956b4d948.jpeg)) | ffish.asia / floraZia.com | CC0 | 216,246 | specimen photogrammetry, dull | real anatomy, wrong species | body-shape reference only, not in manifest |

Reference photos (in manifest, downloaded): `wm-banggai-53953454` (CC BY 4.0, Dan Schofield, watermark in corner, crop it) and `wm-banggai-holleday` (CC BY 3.0, Holger Krisp); CC BY-SA extras `wm-banggai-stang-8zz` and `wm-banggai-stang-10zz` (David J. Stang, 1000 px wide). Key traits: tall first dorsal and long anal fin, deeply forked tail, three black bars, white spots.

## Environment assets

| Role | Asset | Author | Licence | Faces | Notes |
|---|---|---|---|---|---|
| Plants | [Aquariumplants (Java Fern, Vallisneria etc)](https://sketchfab.com/3d-models/f34fac656a364f8eaeab0918179d6df6) ([render](https://media.sketchfab.com/models/f34fac656a364f8eaeab0918179d6df6/thumbnails/d526331749ca4e16b2e9f7dc0da248f7/cea607bc09354350b90e3c6e3edbc04a.jpeg)) | Nullified | CC-BY 4.0 | 130,860 | split per plant and decimate; picked |
| Plants | [Pond Weed](https://sketchfab.com/3d-models/b34ed521c5bb45ca9191b6213e1830d6) ([render](https://media.sketchfab.com/models/b34ed521c5bb45ca9191b6213e1830d6/thumbnails/b6441940c5b44fce84e08434d8695268/1e2fa5b9038445b8807adae30cb66333.jpeg)) | Valery.Li | CC-BY 4.0 | 7,549 | stem plant; picked |
| Plants | [Water plant](https://sketchfab.com/3d-models/b536fec3648f485087c8dd280e749502) ([render](https://media.sketchfab.com/models/b536fec3648f485087c8dd280e749502/thumbnails/42d4291e40874e7abf43c7e5a0536318/9653234729014971a6985a86e143f722.jpeg)) | Nataly | CC-BY 4.0 | 6,076 | Egeria-like stem; picked, but the file has no texture images (flat colour), so it needs a leaf texture |
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

## Reef additions (issue #79)

Checked 2026-10-13. Licence, author and downloadable flag from the Sketchfab API model record; ambientCG licence from the asset page. Renders are Sketchfab thumbnails (linked, not committed). Picks are downloaded and in the manifest; other candidates are listed only.

### Live-rock arch (about 0.3 m, coralline pink/purple)

**Decision: pick `sketchfab-4db2b936`**, with caveats below.

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Archway Rock Formation](https://sketchfab.com/3d-models/4db2b936751a4aa89af6b2afeca05248) ([render](https://media.sketchfab.com/models/4db2b936751a4aa89af6b2afeca05248/thumbnails/329398d1ab494aa6baeb9e1a728033a1/96c404fa99eb4cdbaf691a386652c6d6.jpeg)) | NE14ABJ | CC-BY 4.0 | 6,920 | 1024 PBR, grey with a faint pink cast | a true low arch, smooth sculpt, not porous | PICK |
| 2 | [Underwater rock Tunnel](https://sketchfab.com/3d-models/f9bfa9f385554e12b8652a20c27e93c3) ([render](https://media.sketchfab.com/models/f9bfa9f385554e12b8652a20c27e93c3/thumbnails/6c0b82b84a474bbe96ca18130c20befd/232de355e09d48db9bf27e4844c5c963.jpeg)) | vapor_ | CC-BY 4.0 | 10,646 | green algae look, tagged aquarium | tunnel-like lump, no clear arch | reject |
| 3 | [Rock arch formation](https://sketchfab.com/3d-models/b4cb27574f2e442592252ce50611c5c8) ([render](https://media.sketchfab.com/models/b4cb27574f2e442592252ce50611c5c8/thumbnails/e28ba1ff94b042a9bfd2000ec73808d6/b6269b847d7d4aa984530ba8987099c7.jpeg)) | bfxfactory01 | CC-BY 4.0 | 33,468 | none (white clay), AI-generated (Rodin) | good arch shape | reject: untextured and AI-generated |

No CC0/CC-BY model of real porous live rock exists on Sketchfab (searches: live rock, reef rock, porous rock, coral rock, coralline). The pick therefore supplies the arch silhouette only; the pipeline has to add the pink/purple coralline tint and a procedural pore normal/occlusion layer. Poly Haven `coast_rocks_05` (already registered) is the porous-surface reference.

### SPS (table or digitate Acropora)

**Decision: pick `sketchfab-9ff5270c` (Acropora cytherea, table)**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Madrepora cytherea](https://sketchfab.com/3d-models/9ff5270cafce4ceab61ce84c41c26faa) ([render](https://media.sketchfab.com/models/9ff5270cafce4ceab61ce84c41c26faa/thumbnails/29dc243172cf44e6a537da6a87a85e0e/abec6518317c41cc9fdc6c35fcb7efc5.jpeg)) | Smithsonian | CC0 | 100,000 | 2048 scan, bleached skeleton on plinth | classic table, accurate | PICK |
| 2 | [Madrepora hyacinthus](https://sketchfab.com/3d-models/5e8f3939400d4753bcb8e4a43819473c) ([render](https://media.sketchfab.com/models/5e8f3939400d4753bcb8e4a43819473c/thumbnails/3a425a65111a468f9bfc6cc22a79000e/5a7baa6c1a494e3ca857da153c55e662.jpeg)) | Smithsonian | CC0 | 100,000 | 2048 scan, bleached | upright branching, reads as digitate | alternate, not downloaded |
| 3 | [Tabulate Acropora spp. 8 2014](https://sketchfab.com/3d-models/1364b7bac06544f6972d7b81b5b87542) ([render](https://media.sketchfab.com/models/1364b7bac06544f6972d7b81b5b87542/thumbnails/8e159a57f2b54a01a8da508b5577bd0e/640x360.jpeg)) | renataferrari | CC-BY 4.0 | 85,984 | live colour, blobby field photogrammetry | table, low detail | alternate, not downloaded |

All Smithsonian corals are bleached skeletons with a museum plinth: crop the plinth and tint.

### LPS (hammer or torch)

**Decision: no suitable model exists.** Searches for Euphyllia, torch, hammer, frogspawn, Catalaphyllia, Plerogyra, Physogyra, Caulastrea, Lobophyllia, Acanthastrea, Cynarina, Galaxea and Blastomussa returned nothing under CC0 or CC-BY except hobbyist/fantasy pieces (Brian Trepanier's 0.9 to 2.2M-face art reefs, neonatus.exe "Frogspawn" game assets). Euphyllia needs soft tentacles that no skeleton scan gives; the recommended route is a procedural TSL/loft coral (as for the anemone), with Euphyllia photos from Wikimedia if a texture reference is wanted.

Registered as LPS stand-ins so the scene has some large-polyp coral meanwhile; neither is a hammer or torch:

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Fungia scutaria (Mushroom coral)](https://sketchfab.com/3d-models/e72cb3bdfd504df3a31d38721f1f8a86) ([render](https://media.sketchfab.com/models/e72cb3bdfd504df3a31d38721f1f8a86/thumbnails/f81f16177d5947438a9877f9759f9960/720x405.jpeg)) | Phelpst | CC-BY 4.0 | 178,319 | vertex colours, live green/yellow | plate coral, sculpted not scanned | stand-in (downloaded) |
| 2 | [Goniopora columna](https://sketchfab.com/3d-models/6b652ae52c4d4232b26cfb5b900f7d8a) ([render](https://media.sketchfab.com/models/6b652ae52c4d4232b26cfb5b900f7d8a/thumbnails/3addc83289f94e90a480fd7e5fa54912/1c345d33cf5449fab005bd85ff017d43.jpeg)) | Smithsonian | CC0 | 100,000 | 2048 scan, bleached skeleton | flowerpot-coral colony, only 0.1 m, no polyps | stand-in (downloaded) |
| 3 | [Coral: Eusmilia fastigata](https://sketchfab.com/3d-models/b20e7b87618e4fab97453fd65febc6c3) ([render](https://media.sketchfab.com/models/b20e7b87618e4fab97453fd65febc6c3/thumbnails/7c127c1fafe249419a661efc842265d9/d1fdc9d94de6438a9ba7ca4daf315a05.jpeg)) | Digital Atlas of Ancient Life | CC0 | 251,756 | scan, skeleton | Caribbean flower coral (LPS), heavy | not downloaded |

### Pale aragonite sand

**Decision: pick `ambientcg-Ground101`** (CC0, 2K PBR, tagged beige/white/fine). Poly Haven's sand textures (`sand_01..03`, `dense_sand`, `coast_sand_01..05`, `playground_sand`, `aerial_sand`) all read brown or grey. ambientCG Ground092A/B, 096A/B and 027 are pale as well but strongly rippled or pitted, which looks wrong tiled on a tank floor.

## Extended roster (issue #24)

Checked 2026-10-15. Licence, author and downloadable flag from the Sketchfab API model record; Commons licences from the file page metadata (API `extmetadata`). Renders are the Sketchfab thumbnails on the linked pages (not committed). Picks are downloaded and in the manifest; other candidates are listed only. Searches run on Sketchfab (CC0 and CC-BY filters) and Commons.

### Discus (Symphysodon aequifasciatus)

**Decision: pick `sketchfab-f623d697`**, alternate colourway `sketchfab-e284e187`.

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Discus symphysodon](https://sketchfab.com/3d-models/f623d69769b249a2b55025c000c97499) | Chenchanchong | CC-BY 4.0 | 8,033 | 4 materials (3 textured), 4096 maps (about 60 MB), reticulated turquoise | tall round disc, long dorsal and anal fins, red eye | PICK: downscale to 2048 or less, needs the spine rig |
| 2 | [Discus 3](https://sketchfab.com/3d-models/e284e187712e4e00b001ce773398ad51) | Comitre | CC-BY 4.0 | 3,456 | 1024x512 photo texture, red and white | plausible disc, rigged (11 joints), authored in cm | alternate colourway for tintVariation |
| 3 | [Discus_1](https://sketchfab.com/3d-models/07ca0c407dc54be5a449b84eafa8977e) | Comitre | CC-BY 4.0 | 3,092 | orange stripes | fine | not downloaded, spare |

Other candidates seen and not used: the same mesh as #1 re-uploaded by adyatttt (`184c187d`), Comitre's Discus_Animated (`ab3afd24`, 1,276 faces) and a game drone tagged `warrobots` that is not a fish. Reference photos on Commons exist under CC0 (Bernard Spragg) and CC-BY 4.0 (Freekingdom300) but are not in the manifest because the model has its own texture.

### Harlequin rasbora (Trigonostigma heteromorpha)

**Decision: fallback: procedural loft**

No Sketchfab model with an allowed licence exists (searches: rasbora, trigonostigma, tropical fish). Reference photos (in manifest, downloaded): `wm-rasbora-vassil` (CC0, lateral, 1989x1304, the best) and `wm-rasbora-roy` (CC BY 4.0, Zakqary Roy, 2048x904). CC BY-SA lateral photos also exist (Lascorz, NasserHalaweh) and are unused. Key traits for the loft: copper-pink body, a black pennant-shaped patch over the rear half, red-edged eye, clear fins.

### Bristlenose pleco (Ancistrus sp.)

**Decision: pick `sketchfab-65133817`, with caveats**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Ancistrus sp. Orange](https://sketchfab.com/3d-models/65133817c7f740cbb17e92989a55da72) | faerbogdan99 | CC-BY 4.0 | 40,000 | 2048 PBR, blocky base colour | correct genus: sucker mouth, cheek odontodes, snout tentacles | PICK: orange morph, so recolour or fall back to a loft if a lit render looks poor |
| 2 | [Hypostomus / Coroncoro](https://sketchfab.com/3d-models/3c4466d5f0ce4b2e81a692ba89807ced) | alzarac | CC-BY 4.0 | 39,968 | 1024, spotted common pleco | good scan, wrong genus | reject: species (downloaded to the raw cache, not in the manifest) |

I checked only the Sketchfab thumbnail and the downloaded texture, not a lit side render. The pipeline should decimate to 10k triangles or less, build the spine rig, and tint the body brown with pale spots using `wm-ancistrus-ladenthin` (CC0, head-on close-up of the tentacles and spot pattern, not lateral). Lateral Commons photos of Ancistrus are CC BY-SA and unused.

### Cherry shrimp (Neocaridina davidi)

**Decision: fallback: procedural shrimp (not the fish loft)**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Shrimp [Low Poly]](https://sketchfab.com/3d-models/652650059ff949b39bbed3bfc34d5e87) | Fecalis | CC-BY 4.0 | 2,404 | boiled-prawn look | wrong species and cooked | reject |
| 2 | [generic shrimp](https://sketchfab.com/3d-models/2daef0734a134f35a708581fe33f23f0) | farizulazman | CC-BY 4.0 | 36,780 | generic | not checked beyond the thumbnail | reject: not a dwarf freshwater shrimp |

Reference photos (in manifest, downloaded): `wm-cherry-dagostino-1` and `wm-cherry-dagostino-2` (CC BY 4.0, Uccio D'Agostino, 4288x2848). The second is a weak reference (mostly snails). A CC0 Commons photo was dropped because it is tiny and brownish.

### Six-line wrasse (Pseudocheilinus hexataenia)

**Decision: fallback: procedural loft**

No Sketchfab model with an allowed licence exists (searches: wrasse, pseudocheilinus). Reference photo (in manifest, downloaded): `wm-sixline-huffman` (CC BY 3.0, Lonnie Huffman, 1867x1244, lateral). It is the only good allowed-licence photo: the others are CC BY 2.0 (rejected by `assets:check`), CC BY-SA 4.0 or public-domain drawings. Key traits: six orange lines on blue-violet, green caudal with a spot at the peduncle, orange snout.

### Firefish (Nemateleotris magnifica)

**Decision: fallback: procedural loft**

No Sketchfab model with an allowed licence exists (searches: firefish, nemateleotris, dartfish, fire goby, goby). Reference photo (in manifest, downloaded): `wm-firefish-karelj` (CC0, Karelj, 2400x1699). It is the only allowed-licence photo, and the long first dorsal spine is cropped out of the frame, so model it from the body outline (white-lilac front, orange-red rear, red dorsal and caudal fins edged black, trailing pelvic fin). The other Commons firefish photos are CC BY 2.0 or CC BY-SA.

### Skunk cleaner shrimp (Lysmata amboinensis)

**Decision: fallback: procedural shrimp (not the fish loft)**

No model of the species exists under an allowed licence. The CC0 ffish.asia scans cover other shrimp only (for example [Saron marmoratus](https://sketchfab.com/3d-models/a4863d7e05ce4117bfda48ddf6af8af4), 282k faces, wrong species and too heavy), so at most they serve as a body-shape reference. Reference photos (in manifest, downloaded): `wm-cleaner-huffman` (CC BY 3.0), `wm-cleaner-caruso` and `wm-cleaner-schofield` (CC BY 4.0). Key traits: red body with a white dorsal stripe, white antennae and white-tipped legs.

### CC-BY-SA photos approved for four species (2026-10-15)

Alex approved CC BY-SA lateral reference photos for the firefish, six-line wrasse, harlequin rasbora and bristlenose pleco. Picks, chosen from a visual comparison of the Commons candidates (3.0 and 4.0 only; 2.0 and 2.5 are not on the project's list): `wm-firefish-hobgood` (Nick Hobgood, BY-SA 3.0, shows the long dorsal spine), `wm-rasbora-dabrowski` (Mariusz Dabrowski, BY-SA 3.0, true lateral), `wm-sixline-delso-63` (Diego Delso, BY-SA 4.0), `wm-ancistrus-reis` (Julio Reis, BY-SA 4.0, wild-type colour, tail cropped) and `wm-ancistrus-l144-adolfoi` (Corydoras-adolfoi, BY-SA 4.0, full outline, albino morph so shape only). Textures derived from them are CC-BY-SA. The share-alike allowlist in `tools/asset-pipeline/src/manifest.ts` must list these ids before `pnpm assets:check` accepts them.

## Clean-up crew and cleaner wrasse (issue #630, T40 and T44)

Checked 2026-10-16. Sketchfab was searched for CC0 and CC-BY downloadable models; every candidate below carries the licence and downloadable flag on its Sketchfab record. The ffish.asia scans considered here (the two picks and the rejected alternatives) are CC0 photogrammetry of preserved specimens, so they are heavy (390k to 1.3M faces, 8192x8192 base colour) and need the pipeline to decimate and downscale. Each scan also contains a 2 cm colour-checker cube mesh that must be dropped.

**Fallback summary:** hermit crab uses a scan. Nerite snail uses a scan for the shell only; the foot, head and tentacles are **procedural** (reference photos below). Cleaner wrasse has no model and uses the **procedural loft**.

### Nerite snail (freshwater; Neritina/Clithon family)

**Decision: pick `sketchfab-70b8866a` for the shell, procedural soft body**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Clithon sowerbianus](https://sketchfab.com/3d-models/70b8866a910f49a68982888e64a3f900) ([render](https://media.sketchfab.com/models/70b8866a910f49a68982888e64a3f900/thumbnails/4fddac3303a740c6ac86650a41244aff/350c96af28e44b2da0fd5f5209573055.jpeg)) | ffishAsia-and-floraZia | CC0 | 394,418 | 8192x8192 base colour, gold and dark zig-zag banding like the aquarium zebra nerite | correct shell, about 0.7 cm, no soft body | PICK |
| 2 | [Neritina plumbea](https://sketchfab.com/3d-models/d779869759434a9e9372c1a9c9969399) ([render](https://media.sketchfab.com/models/d779869759434a9e9372c1a9c9969399/thumbnails/c75ca8948c634a4987b44ed68a27c058/32a6f4a6d5fb47b3925b79deba2bccd4.jpeg)) | ffishAsia-and-floraZia | CC0 | 388,084 | plain brown, worn | true Neritina, but dull and no pattern | reject: nothing to recognise as a nerite in a tank |
| 3 | [Red Nerite Shell](https://sketchfab.com/3d-models/5cf3efaedfc44b2db97f24d29a427be4) ([render](https://media.sketchfab.com/models/5cf3efaedfc44b2db97f24d29a427be4/thumbnails/67caa7c7037a409498d5306207a0c82d/9ada68fb4c3749b6a72df4e33af673ae.jpeg)) | RISDNaturelab | CC-BY 4.0 | 38,234 | red with dark dots, low resolution | a marine Nerita with a partly broken base | reject: wrong look for a freshwater nerite |

Reference photos (in manifest, downloaded): `wm-nerite-baldonado-1` and `wm-nerite-baldonado-2` (CC BY 4.0, Evan Baldonado; the second shows the foot and operculum from below) and `wm-nerite-obsidian-05` (CC0, shows the dark foot, head and tentacles). All other Commons zebra nerite photos are CC BY-SA and were not used. Key traits: dome-shaped shell with banding, thick dark grey foot, two short tentacles, no visible spire.

### Hermit crab (reef; Clibanarius)

**Decision: pick `sketchfab-5ebe7794`**

| # | Candidate | Author | Licence | Faces | Texture | Anatomy | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [Clibanarius longitarsus](https://sketchfab.com/3d-models/5ebe7794183346e998afb97b68021158) ([render](https://media.sketchfab.com/models/5ebe7794183346e998afb97b68021158/thumbnails/68eefea4d6244d208b89596e991cd50c/d2c2d2f3b7fd40d69aaa995be71845e7.jpeg)) | ffishAsia-and-floraZia | CC0 | 495,292 | 8192x8192 base colour, olive legs with banding | real hermit crab in a conical shell, legs and eyestalks intact | PICK |
| 2 | [Dardanus aspersus](https://sketchfab.com/3d-models/8e1a156487bf4c0c8fc684e08ee16006) ([render](https://media.sketchfab.com/models/8e1a156487bf4c0c8fc684e08ee16006/thumbnails/3d291e42ff1e49dda40ce659a48568f5/4e6b43ebca8a498cb8b4382147bbba29.jpeg)) | ffishAsia-and-floraZia | CC0 | 794,059 | 8k photogrammetry | good, a large anemone-carrying species | reserve: heavier and less like the common reef hermit |
| 3 | [Dardanus crassimanus](https://sketchfab.com/3d-models/a7216d61f2d7401a97da99a4a8ee6823) ([render](https://media.sketchfab.com/models/a7216d61f2d7401a97da99a4a8ee6823/thumbnails/775655e536764d34a8f33b9da4d9d239/f3533ceee3094991b010456ca4db4701.jpeg)) | ffishAsia-and-floraZia | CC0 | 963,500 | 8k, red-orange, spiny murex shell | good | reserve: too large and ornate for a small cleaner |

The CC-BY hermit crabs (Wermin 319,616 faces fimo-clay magnet, Blaast 25,184, Xfdfgd 40,154) are modelled by hand or stylised and were not considered further. The scan has no rig; legs are one fused mesh, so the pipeline needs a simple walk rig or procedural leg motion.

### Bluestreak cleaner wrasse (Labroides dimidiatus)

**Decision: fallback: procedural loft** (for T44, #634)

No Sketchfab model exists under any licence for the species (searches: labroides, cleaner wrasse, bluestreak, Labridae, wrasse; the only hits are other wrasses such as the CC0 ffish.asia scans of *Pseudolabrus*, *Bodianus* and *Choerodon*, which are the wrong shape and 590k to 1.3M faces). Reference photos (in manifest, downloaded): `wm-labroides-jens` (CC BY 4.0, 1571x1066, near-lateral, sharp head) and `wm-labroides-hylton` (CC BY 4.0, 1459x973, true lateral, outline only). Key traits: long slender body, terminal mouth, a black lateral stripe that widens to the tail, white-blue belly, blue and black caudal. The Commons CC0 photo (`georgiasteel`, 881x881) is too small and distant to use. The sharper Commons shots by Diego Delso are CC BY-SA 4.0 and are not used, since the approval for CC BY-SA photos covers other species only.

## Downloaded-file check (Sketchfab)

Measured from each downloaded `scene.gltf`. Rigged means the glTF has at least one skin; the clips are what the author shipped and are not the swim cycles we need.

| Asset | Triangles | Textures | Skins / joints | Clips |
|---|---|---|---|---|
| Neon tetra (`sketchfab-2fabf5db`) | 1,498 | 3 images, largest 1024x1024 | 1 / 30 | 1 |
| Angelfish (`sketchfab-e03ff546`) | 3,088 | 4 images, largest 2048x2048 | 0 / 0 | 0 |
| Betta (`sketchfab-f4eeb7f5`) | 10,668 | 3 images, largest 2048x2048 | 1 / 53 | 1 |
| Guppy male (`sketchfab-21e14e4b`) | 1,689 | 3 images, largest 2048x2048 | 1 / 44 | 1 |
| Guppy female (`sketchfab-feab250d`) | 6,548 | 4 images, largest 2048x2048 | 1 / 191 | 2 |
| Clownfish (`sketchfab-47ba2679`) | 1,606 | 3 images, largest 2048x2048 | 0 / 0 | 0 |
| Blue tang (`sketchfab-00dac50e`) | 3,688 | 4 images, largest 2048x2048 | 0 / 0 | 0 |
| Yellow tang (`sketchfab-5750f70a`) | 1,184 | 1 images, largest 1024x1024 | 0 / 0 | 0 |
| Plants (set) (`sketchfab-f34fac65`) | 130,860 | 5 images, largest 4096x4096 | 0 / 0 | 0 |
| Pond weed (`sketchfab-b34ed521`) | 7,549 | 9 images, largest 512x512 | 0 / 0 | 0 |
| Water plant (`sketchfab-b536fec3`) | 6,076 | none | 1 / 30 | 1 |
| Driftwood scan (`sketchfab-c53807ef`) | 40,000 | 3 images, largest 4096x4096 | 0 / 0 | 0 |
| Acropora palmata (`sketchfab-8cb98631`) | 100,000 | 3 images, largest 2048x2048 | 0 / 0 | 0 |
| Brain coral (`sketchfab-4ea44ce7`) | 40,002 | 2 images, largest 8192x8192 | 0 / 0 | 0 |
| Reef coral piece (`sketchfab-f2542a86`) | 22,057 | 1 images, largest 2048x2048 | 0 / 0 | 0 |
| Archway rock (`sketchfab-4db2b936`) | 6,920 | 3 images, largest 1024x1024 | 0 / 0 | 0 |
| Table coral (`sketchfab-9ff5270c`) | 100,000 | 3 images, largest 2048x2048 | 0 / 0 | 0 |
| Goniopora (`sketchfab-6b652ae5`) | 100,000 | 3 images, largest 2048x2048 | 0 / 0 | 0 |
| Fungia (`sketchfab-e72cb3bd`) | 178,319 | none (vertex colours) | 0 / 0 | 0 |
| Discus (`sketchfab-f623d697`) | 8,033 | 8 images, largest 4096x4096 | 0 / 0 | 0 |
| Discus 3 (`sketchfab-e284e187`) | 3,456 | 2 images, largest 1024x512 | 1 / 11 | 1 |
| Ancistrus sp. Orange (`sketchfab-65133817`) | 40,000 | 3 images, largest 2048x2048 | 0 / 0 | 0 |
| Hermit crab (`sketchfab-5ebe7794`) | 495,292 | 2 images, largest 8192x8192 | 0 / 0 | 0 |
| Nerite shell (`sketchfab-70b8866a`) | 394,418 | 2 images, largest 8192x8192 | 0 / 0 | 0 |

Effect on the picks: none of the picks flipped. The neon tetra, betta and both guppies ship skeletons (30, 53, 44 and 191 joints) that the pipeline can reuse or replace with a spine rig; the clownfish, both tangs and the angelfish are unrigged static meshes and need the procedural spine rig. The angelfish uses unlit materials, the water plant has no textures, and the brain coral is 8192x8192 and must be downscaled. Blue and yellow tang stay as weak candidates for the auditor to weigh against the loft fallback.

## Tank backgrounds (issue #616, T26)

Checked 2026-10-16. Photographs from Wikimedia Commons; licence read from the file page metadata, and the Commons sha1 matches each download. Picks are in the manifest (`kind: "background"`, with a 2:1 `crop` box); raw files stay in `~/.cache/aquarium-assets/raw/<id>/original.jpg`. Every crop is at least 3618 px wide, so the T27 step can resize to 2048x1024 and encode KTX2. Nothing here is processed or committed as an image.

Poly Haven, ambientCG and Smithsonian have no underwater or aquarium-backdrop photos, and Sketchfab holds models rather than pictures, so every candidate is from Commons. CC BY 2.0, CC BY-SA, public-domain-mark and unclear files were skipped.

### Freshwater

| Slot | Pick | Licence | Source | Caveat |
|---|---|---|---|---|
| Planted stream | `bg-fw-planted-stream` | CC0, Royonx | 4724x3543 | Freshwater Elodea canadensis bed streaming over sand, blue-green water. No fish. Crop 4724x2362 at (0,700). |
| Sunken roots | `bg-fw-root-tangle` | CC BY 3.0, David Perez | 3872x2592 | Alder (Alnus glutinosa) roots trailing red in a clear stream over stones. Dark and contrasty, a close view not a wide tangle. Crop 3872x1936 at (0,400). |
| Rocky riverbed | `bg-fw-rocky-riverbed` | CC0, WilliamRobertoMiranda (Flickr CC0 confirmed) | 7360x4912 | Rio Doce stones and gravel under shallow clear water with rippled sunlight; warm, soft and slightly hazy. Crop 7360x3680 at (0,600). |
| Misty planted tank | `bg-fw-misty-lake` | render (T27), CC BY 4.0 via plant credits | n/a | Pending render of a freshwater planted scene, see below. |
| Deep green plant wall | `bg-fw-plant-wall` | CC0, Adiyazzz | 4032x3024 | Densely planted freshwater aquarium with a few neon-type tetras; no glass or hardware visible. Crop 4032x2016 at (0,400). |

Render spec for `bg-fw-misty-lake` (freshwater subjects only, nothing marine or brackish; T27, asset-pipeline-engineer; manifest `source: "render"`, status `selected-pending-download`, sha256 null until committed): a dense planted tank from the front glass, 2:1, at least 4096x2048, no fish, no text. Plants (CC-BY, credit Nullified and Valery.Li): Java fern and vallisneria from `sketchfab-f34fac65` mid and back, Pond Weed `sketchfab-b34ed521` clumps left and right. Hardscape and substrate (CC0): `polyhaven-dead_quiver_trunk` as a diagonal root left of centre, `polyhaven-boulder_01` and `polyhaven-coast_rocks_05` as 2 to 3 stacked rocks, `polyhaven-clean_pebbles` foreground with `ambientcg-Ground101` blended as sand. Composition: tall plants and driftwood on the outer thirds, an open lower centre, a soft misty blue-green gradient (pale top, darker base), soft top light and no hard shafts. Camera at plant midline height, 35 mm equivalent, shallow depth of field on the far plants. The licence stays CC-BY because the plant models are CC-BY.

The first freshwater picks (eelgrass, mangrove roots, dry shore pebbles, land moss) were dropped on review because they were not freshwater underwater scenes. Mangrove roots (`Tangled Mangrove Roots.jpg`, CC BY 4.0, Vinno Christopan; brackish) are kept as a note for the future mangrove biome (T50). Also seen and not used: `Underwater-photography-pond-plants-1529207.jpg` (CC0, freshwater pond plants with a bright surface strip, a good alternative for the misty slot), the River Sherbourne and Coventry series (CC BY 4.0, murky and watermarked), Aquascape mini, Planted Nano Aquarium and Nature Aquarium Aquascape (CC0, but the tank glass, lights or wall are in frame). The root-tangle and riverbed picks are softer than the reef set, which is the best that Commons offers under an allowed licence.

Runners-up not taken: `Nature Aquarium Aquascape.jpg` (CC0; a glass tank with a visible rim), `Misty lake (Unsplash).jpg` and `Mist over the lake shore (Unsplash).jpg` (CC0 on Commons but re-uploaded from Unsplash, so the CC0 claim is second-hand), `Fallen tree and ferns (Unsplash).jpg` (too dark), `Mangrove Floating roots.jpg` (CC BY 4.0, brown water and a bright sky patch).

### Reef

| Slot | Pick | Licence | Source | Caveat |
|---|---|---|---|---|
| Coral reef wall | `bg-reef-coral-wall` | CC BY 4.0, 74papa | 5472x3072 | Good. A few small fish in the frame. |
| Open blue with light rays | `bg-reef-light-rays` | CC0, Sirrob01 | 3648x2736 | Staghorn reef under bright cyan water with a cloud of small fish and light from the upper right. Soft light fall-off, not distinct shafts. Crop 3648x1824. |
| Reef slope with fish silhouettes | `bg-reef-fish-slope` | CC BY 4.0, 74papa | 3618x2373 | Smallest source of the set. Anthias are sharp, not silhouettes. |
| Soft-coral garden | `bg-reef-soft-coral` | CC BY 4.0, AlexeiAVA | 4000x3000 | One sea fan colony, close up. |
| Dark deep-blue with distant reef | `bg-reef-deep-blue` | CC0, Jstuby | 5184x3888 | Mid blue rather than dark. Darken in the pipeline if wanted. |

Replaced the earlier Brittany sun-starburst pick (dark, no reef). Also seen: `Posidonia oceanica meadow and school of Salema porgy ... Calanque de Sormiou` (CC BY 4.0, marine seagrass, no rays).

Runners-up not taken: `Beneath Sipadan Island.jpeg` (CC0; murky violet-grey), `Caribbean Reef Shark School Tiger Beach Bahamas.jpg` (CC0; the shark is the subject), `Four butterfly fish swim over a coral reef.jpg` (CC BY 4.0; the fish are the subject), `Deep blue cozumel 2018.jpg` (CC0; a diver in frame), the other Ifremer "Ambiance sous-marine" files (a diver in every frame), `Рифы бухты Шарм-Эль-Майя.jpg` (CC0; a close second for the reef wall).

Banding check (2026-10-16): the blue channel of an 800x400 gradient region of the deep-blue, light-rays and coral-wall originals holds a contiguous run of levels (81 of 81, 89 of 90, about 180 of 202), so the banding seen in the contact sheet is the preview PNG palette, not the sources.

## African cichlid lake (issue #638, T48)

Checked 2026-10-19. Sources searched in order: Smithsonian (no fish models of these species), Sketchfab with the CC0 and CC-BY filters and the downloadable flag, Poly Haven, ambientCG, Wikimedia Commons. Licences were read from the Sketchfab model record and bundled `license.txt`, the Poly Haven asset page and the Commons file-page metadata. Raw files are in `~/.cache/aquarium-assets/raw/<id>/`. No CC-BY-SA was used or added.

### Species

| Species | Decision | Pick | Polycount | Notes |
|---|---|---|---|---|
| Demason's cichlid (Pseudotropheus demasoni, Malawi) | model | `sketchfab-f7f3faca` (Ra_in_coat, CC-BY-4.0) | 2174 faces | Rigged (64 joints, one `SWIM_CYCLE` animation, stray `Cube_helper` node). Right outline and bar pattern; painted texture, 2 maps. Only allowed cichlid model found. |
| Electric yellow cichlid (Labidochromis caeruleus, Malawi) | fallback: procedural loft | `wm-labidochromis-chmee2` (CC BY 3.0), `wm-labidochromis-severni` (CC0) | n/a | No allowed model. A third photo (`Labidochromis caeruleus F.jpg`, Stacnbake) is smaller and was not downloaded. |
| Golden mbuna (Melanochromis auratus, Malawi) | fallback: procedural loft | `wm-melanochromis-5snake5-female`, `-male` (CC0), `wm-melanochromis-lee-1` (CC BY 3.0) | n/a | Male and female differ strongly (gold with dark stripes versus blue-black with pale stripes): loft needs two texture sets. |
| Black calvus (Altolamprologus calvus, Tanganyika) | fallback: procedural loft | `wm-altolamprologus-5snake5` (CC0) | n/a | One photo. Tall dorsal fin and compressed body. |
| Fairy cichlid (Neolamprologus brichardi, Tanganyika) | gap: no reference | none | n/a | The only CC0 or CC-BY photo found, Marrabbio2's `Neolamprologus brichardi femmina.jpg` (CC BY 3.0), is described on its Commons page as "Neolamprologus olivaceus female" and sits in the olivaceus category, so it is not in the manifest. Everything else under Neolamprologus brichardi or pulcher on Commons is a journal figure page. The species needs a correctly identified photo (or a Sketchfab model) before it can be lofted; without one the biome ships with the four species above, which meets the 4-species minimum. |

The PLAN lists 4 or more species. With the four that have references the biome has one model and three lofts. Gaps Alex may want to know about: no Aulonocara (peacock) and no shell-dweller (Neolamprologus multifasciatus) photo or model exists under an allowed licence (everything found was CC BY-SA, CC BY 2.0 or a public-domain mark). Species ids are proposals; `content/species/*.json` belongs to the later owners.

### Hardscape and decor

| Item | Pick | Licence | Notes |
|---|---|---|---|
| Rock pile, anchor | `polyhaven-namaqualand_boulder_03` | CC0 | 121546 triangles, about 2.4 m wide in the source: decimate hard. |
| Rock pile, mid tier | `polyhaven-namaqualand_boulder_05` | CC0 | 117622 triangles. |
| Rock pile, top and rubble | `polyhaven-rock_07` | CC0 | 27830 triangles, small angular rock. |
| Also reused | `polyhaven-boulder_01`, `polyhaven-coast_rocks_05` | CC0 | Already in the manifest. |
| Sand | `ambientcg-Ground101` (pale fine sand), `polyhaven-coast_sand_01`, `-coast_sand_04` | CC0 | Already in the manifest. The other Poly Haven sands checked (coast_sand_05, sand_02, sand_03) are too dark for a cichlid sand bed. |
| Shell decor | `sketchfab-1bedca25` (Meshfinder, CC-BY-4.0) | CC-BY-4.0 | 3727 faces, photogrammetry scan published by Meshfinder (a Munich 3D-scanning startup) itself. A land-snail shell, scaled to Neothauma size (3.5 to 5 cm). |

### Backgrounds (render specs, not yet in the manifest)

The only Commons photos of Lake Tanganyika under CC0 or CC BY (Edouard mhg, Bujumbura shoreline) are above water with people, boats and buildings, so none are usable posters. No allowed underwater Malawi or Tanganyika scene exists. Rock and sand are CC0 on Poly Haven, so the five slots are renders in the `bg-fw-misty-lake` pattern. They are not in `assets/manifest.json` yet: the committed-backgrounds suite in the asset-pipeline package expects every background entry to be built. The pipeline PR that renders them adds them as `downloaded` entries with `kind: "background"`, `biome: "cichlid"`, `source: "render"` and the slot below.

| Slot | Id | Licence |
|---|---|---|
| Malawi rock pile | `bg-cichlid-malawi-rock-pile` | CC0 |
| Granite rock wall | `bg-cichlid-rock-wall` | CC0 |
| Tanganyika shell bed | `bg-cichlid-tanganyika-shell-bed` | CC-BY-4.0 (shell credit, Meshfinder) |
| Rock cave | `bg-cichlid-rock-cave` | CC0 |
| Open blue water | `bg-cichlid-open-blue` | CC0 |

Every render: The render must carry no EXIF or other metadata, no fish, no text and no people. 2:1, at least 4096x2048, graded underwater by the pipeline (the renderer tints the poster once more with water absorption, so keep the grade light), soft light fall-off from the top and no hard sun shafts. Freshwater only: nothing marine.

- `bg-cichlid-malawi-rock-pile`: A three-tier rock pile seen from the front glass: polyhaven-namaqualand_boulder_03, polyhaven-namaqualand_boulder_05, polyhaven-rock_07 and polyhaven-boulder_01 (all CC0), with polyhaven-namaqualand_boulder_03 as the large anchor left of centre, boulder_05 and rock_07 stacked on and beside it, rubble at the base on ambientcg-Ground101 pale sand. Gaps between rocks stay dark (caves for mbuna). Clear blue-green water above, centre third lower and open.
- `bg-cichlid-rock-wall`: A near-vertical wall of stacked granite built from polyhaven-namaqualand_boulder_03, polyhaven-namaqualand_boulder_05, polyhaven-rock_07 and polyhaven-boulder_01 (all CC0), filling the left and right thirds, with a diagonal ledge and narrow cracks, pale sand strip at the base, a lighter water gap in the centre third. Warm grey rock against cool blue-green water.
- `bg-cichlid-tanganyika-shell-bed`: A wide pale sand floor (ambientcg-Ground101, polyhaven-coast_sand_04) scattered with 30 to 60 instances of sketchfab-1bedca25 (Snail Shell, Meshfinder, CC-BY-4.0) at varied scale and rotation, a few half-buried, with 2 to 3 small rocks (polyhaven-rock_07, polyhaven-boulder_01) and soft blue-green water above. Licence is CC-BY-4.0 because the shell model is CC-BY: the Meshfinder credit must stay in CREDITS.md.
- `bg-cichlid-rock-cave`: A dark cave mouth framed by polyhaven-namaqualand_boulder_03, polyhaven-namaqualand_boulder_05, polyhaven-rock_07 and polyhaven-boulder_01 (all CC0): an arch built from boulder_03 and boulder_05, lit from the left, sand at the foot and a deep shadow gradient inside. Cichlid caves for spawning. Cooler and darker than the other slots.
- `bg-cichlid-open-blue`: Open blue water with a distant rock slope (small boulders from polyhaven-namaqualand_boulder_03, polyhaven-namaqualand_boulder_05, polyhaven-rock_07 and polyhaven-boulder_01 (all CC0), heavy depth haze) running along the bottom third, the upper two thirds open and smoothly graded blue-green, a faint lighter patch top right. The calmest slot, for tanks with a lot of foreground decor.

For the shell-bed render, `source_url` and `author_url` should point to the shell (`https://sketchfab.com/3d-models/snail-shell-photogrammetry-1bedca252e4d46d7b92826271a578154`, `https://sketchfab.com/meshfinder`), because it is the CC-BY component that sets the licence, and its CREDITS row should link the same source. The other four slots credit the Poly Haven rocks (CC0).

The manifest biome will be `cichlid`. `content/backgrounds/cichlid.json` and the ids in `packages/shared/src/backgrounds.ts` are not added here: `playableBiomeSchema` does not yet include `cichlid`, so the file would fail validation. Add both in the PR that makes the biome playable.

### Handoff to asset-pipeline-engineer

Adult target lengths (total length, approximate): Pseudotropheus demasoni 7 to 8 cm, Labidochromis caeruleus 8 to 10 cm, Melanochromis auratus 10 to 11 cm, Altolamprologus calvus 13 to 15 cm.

1. Demasoni (`sketchfab-f7f3faca`): drop `Cube_helper`, replace the 64-joint skeleton with the pipeline fish rig, orient, scale to 7.5 cm, bake masks, KTX2 at 1k and 2k, LODs.
2. Loft three species from the listed photos: electric yellow (9 cm), golden mbuna in two sexes (10.5 cm), black calvus (14 cm). Credits: `wm-labidochromis-chmee2` (Chmee2) and `wm-melanochromis-lee-1` (lienyuan lee) are CC BY 3.0, the rest CC0. Fairy cichlid (9 to 10 cm) is blocked on a correctly identified reference photo, see the species table.
3. Rocks (`polyhaven-namaqualand_boulder_03`, `-05`, `polyhaven-rock_07`): decimate to LOD0 targets of about 12,000 triangles for boulder_03, 8,000 for boulder_05 and 4,000 for rock_07, then LOD1 at about a quarter of that. Bake normals, ship as a `rock-pile` decor set with at least two arrangements.
4. Shell (`sketchfab-1bedca25`): decimate to three LODs, 1k KTX2, instance-friendly origin, scale to 3.5 to 5 cm (Neothauma-like). The shell normal map is 11.9 MB at source and must be downscaled.
5. Substrate: reuse existing sand textures; no new asset.
6. Backgrounds: render the five slots to the specs above, strip metadata, build the three KTX2 tiers, then add the entries to the manifest with `sha256`, `files[]`, `modifications[]` and status `downloaded`.

## Sound (issue #649, T59)

Checked 2026-10-16 on each Freesound sound page (licence link read from the page; every pick is CC0, so no attribution is required, though CREDITS.md lists them). Searches were restricted to CC0 and CC-BY on Freesound. Raw files are the Freesound `lq` preview OGGs (lossy, about 60 to 80 kbps; the originals need a login and are better quality, so fetching them is the upgrade path if artefacts are audible after the transcode, the low-pass and the normalisation), kept in `~/.cache/aquarium-assets/raw/freesound-<id>/`. Manifest `kind` is the free string `audio`, so the manifest schema needed no change.

**Format and size plan.** Ship each sound as AAC in `.m4a` only, as decided in PLAN 9.1 (no Opus/OGG). Encoders (ffmpeg and similar) are not installed on the sourcing machine, so encoding, loudness normalisation and loop crossfading are left to the pipeline or gameplay agent; the intended steps are in each manifest entry's `notes`, and `modifications` stays empty until they are done. Size: the nine picks total about 0.49 MB as source previews, well within the repo budget; a per-preset audio budget is left to the pipeline PR's size check (T59 audio encoding + size check). Loops are to be trimmed to 12 to 16 s. The built-asset index schema (`tools/asset-pipeline/src/index-schema.ts`) may need an `audio` kind when the pipeline starts emitting these.

| Sound | Pick | Why |
|---|---|---|
| Filter hum (loop) | `freesound-197804` | steady pump hum, no bubble strips, long enough to find a stationary 12 s section |
| Air bubbles (loop) | `freesound-188223` | authored as a loop, 8.4 s |
| Underwater ambience (loop) | `freesound-862788` | explicitly muffled and tagged loop |
| Glass tap | `freesound-427389` | clean single tap, 0.49 s |
| Food plop | `freesound-853279` | small plop, 0.38 s |
| Net splash | `freesound-398032` | shallow splash, 1.3 s, most downloaded of the splash set |
| UI clicks (3) | `freesound-528561`, `freesound-629020`, `freesound-342200` | soft, plain and wooden click, each under 0.3 s |
| Calm music (optional) | **skipped** | the only short CC0 loop found is Freesound 826622 (xkeril, 20 s), but it is a lo-fi electric piano that does not suit an underwater bed; revisit if music is wanted |

### Candidates

All CC0 unless marked.

- **Filter hum:** 1. [Indoor Fish Tank without Bubble strips Ambiance](https://freesound.org/s/197804/) by 7778, 31.2 s (PICK); 2. [fish-tank-fltr-edit](https://freesound.org/s/369861/) by doubleDog, 6.6 s (short, likely an edit with audible repetition); 3. [Aquarium Lobster Filter](https://freesound.org/s/522987/) by vero.marengere, 24 s. CC-BY alternative not needed: Freesound 167748 (ultradust).
- **Air bubbles:** 1. [Bubble Loop](https://freesound.org/s/188223/) by MikeRat, 8.4 s (PICK); 2. [Water bubbles loop](https://freesound.org/s/521392/) by GoldenTricycle, 11.8 s (fizzier, more boiling than aquarium); 3. [Aquarium aerator y bubbles](https://freesound.org/s/418198/) by ddaedalus, 38 s (also carries a pump).
- **Underwater ambience:** 1. [Ambience, designed, deep, muffled, wavy, underwater, dream, memory, loop](https://freesound.org/s/862788/) by Oldome, 25.3 s (PICK); 2. [Underwater Ambience](https://freesound.org/s/504641/) by Fission9, 46.9 s (12k downloads, brighter and longer); 3. [Ambiance_Underwater_Stereo](https://freesound.org/s/482116/) by Nox_Sound, 45 s.
- **Glass tap:** 1. [Glass Tap](https://freesound.org/s/427389/) by zembacraftworks, 0.49 s (PICK); 2. [Glass Tap.wav](https://freesound.org/s/262958/) by Unicornaphobist, 0.2 s (a ting on a bottle, too ringy); 3. [Glass Tap](https://freesound.org/s/668384/) by CJspellsfish, 0.3 s.
- **Food plop:** 1. [Fishing Lure Plop Water - Game SFX (2 or 2)](https://freesound.org/s/853279/) by el_boss, 0.38 s (PICK); 2. [Water.wav](https://freesound.org/s/530359/) by danielpodlovics, 0.33 s; 3. [Water drop (splash)](https://freesound.org/s/451126/) by bolkmar, 1.1 s.
- **Net splash:** 1. [Splash](https://freesound.org/s/398032/) by swordofkings128, 1.3 s (PICK); 2. [WaterSplash](https://freesound.org/s/646568/) by Ryanz-Official, 1.3 s; 3. [water splash 2](https://freesound.org/s/398039/) by swordofkings128, 1.9 s.
- **UI clicks:** picks [Soft UI Button Click](https://freesound.org/s/528561/) by Jummit, 0.24 s, [Button click](https://freesound.org/s/629020/) by Kolombooo, 0.29 s, [Videogame Menu BUTTON CLICK](https://freesound.org/s/342200/) by Christopherderp, 0.14 s; reserves [Button Hover Click](https://freesound.org/s/623990/) by eqylizer, 0.1 s and [Water Click](https://freesound.org/s/371274/) by Mafon2, 0.1 s.
- **Calm music (not picked):** [Memories of a sweet summer (loop)](https://freesound.org/s/826622/) by xkeril, 20 s; [Calming Piano Loop 60bpm](https://freesound.org/s/679738/) by Seth_Makes_Sounds, 109 s (too long for the budget); [Synth pad deep ambience with beach waves](https://freesound.org/s/222448/) by waveplaySFX, 34 s.

Not verified here (no audio tools on the machine): the loop seams. The pipeline must audition each loop and crossfade as planned in the entry notes.
