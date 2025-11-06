from PyInstaller.utils.hooks import collect_data_files

datas = collect_data_files(
    'mediapipe',
    includes=[
        '**/*.binarypb',
        '**/*.tflite',
        '**/*.pbtxt',
        '**/*.textproto',
        '**/*.json',
    ]
)