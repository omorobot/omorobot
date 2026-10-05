import os
from glob import glob
from setuptools import find_packages, setup

package_name = 'omorobot_web'


def web_files():
    # install the web/ tree to share/omorobot_web/web keeping sub directories
    entries = []
    for root, _, files in os.walk('web'):
        if files:
            entries.append((os.path.join('share', package_name, root), [os.path.join(root, f) for f in files]))
    return entries


setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.py')),
        ('share/' + package_name + '/systemd', glob('systemd/*')),
    ] + web_files(),
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Dr.K',
    maintainer_email='t.shaped.person@gmail.com',
    description='Web UI for mapping, points, map editing and job programming',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'web_server = omorobot_web.web_server:main',
            'fake_robot = omorobot_web.fake_robot:main'
        ],
    },
)
