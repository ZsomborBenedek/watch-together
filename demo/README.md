# Demo page

Neutral, unbranded page used to shoot the Chrome Web Store screenshots. It shows
a large timecode and a Playing/Paused badge, so two windows side by side visibly
agree in a still image.

Serve it with the standard library -- the extension only injects into
`http(s)://`, never `file://`, so it does need to be served:

```sh
python3 -m http.server 8080 --directory demo
```

`demo.mp4` is kept small (4 MB / 3 min) so that fetch is quick, since the page
waits on the whole file before the video appears.

The video is gitignored. To rebuild it:

```sh
curl -L -o /tmp/bbb.mp4 \
  https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4
ffmpeg -i /tmp/bbb.mp4 -t 180 -vf scale=854:-2 -c:v libx264 -crf 32 \
  -preset slow -pix_fmt yuv420p -movflags +faststart -an demo/demo.mp4
```

Big Buck Bunny © Blender Foundation, CC BY 3.0.
